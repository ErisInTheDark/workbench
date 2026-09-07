/*
 * Exports:
 * - WORKBENCH_ROUTE_MARKER: route marker for canonical workbench URLs. Keywords: URL, route, navigation.
 * - WorkbenchRouteView, WorkbenchSettingsScope, WorkbenchRoute, WorkbenchRouteParseResult: normalized route contracts. Keywords: URL source of truth, home, project, file, thread, settings, stats, mosaic.
 * - createHomeRoute/createProjectRoute/createFileRoute/createThreadRoute/createPinnedThreadRoute/createHomeThreadRoute/createSettingsRoute/createStatsRoute/createMosaicRoute/createInvalidWorkbenchRoute: construct route objects. Keywords: navigation, route builder, home, pinned, owner.
 * - getWorkbenchThreadTargetRootId/getWorkbenchThreadTargetSelectedId/getWorkbenchMosaicThreadRootIds/isWorkbenchThreadTargetSelected: derive draft, parent hydration, mosaic roots, selected tab identity, and sidebar selection. Keywords: thread, draft, subagent, parent, mosaic.
 * - parseWorkbenchRouteFromLocation/parseWorkbenchRouteFromPath: parse browser URL state without mutating history. Keywords: route parser, legacy query, malformed URL.
 * - createWorkbenchHref/createHomeHref/createProjectHref/createFileHref/createThreadHref/createPinnedThreadHref/createHomeThreadHref/createSettingsHref/createStatsHref: build canonical hrefs. Keywords: links, URL, encode, home, pinned, stats.
 * - isSameWorkbenchRoute/routeHasSelection/isWorkbenchRouteOwnerOfThread: compare, classify, and fence route-owned thread transitions. Keywords: route equality, active selection, draft promotion.
 */

import {
  createWorkbenchProjectHref,
  encodeWorkbenchRoutePath,
} from "../../navigation/workbench-route-path.ts";

import {
  parseWorkbenchMosaicRouteExpression,
  serializeWorkbenchMosaicRouteExpression,
  type WorkbenchMosaicNode,
} from "./workbench-mosaic-route.ts";
import { areDeeplyEqual } from "../deep-equality.ts";
import { WorkbenchThreadTargetSchema, type WorkbenchThreadTarget } from "../thread/thread-state.ts";

export const WORKBENCH_ROUTE_MARKER = "@";

const LEGACY_FILE_SEARCH_PARAM = "file";
const LEGACY_THREAD_SEARCH_PARAM = "thread";
const DEFAULT_SETTINGS_SCOPE: WorkbenchSettingsScope = "global";

export type WorkbenchRouteView = "home" | "project" | "file" | "thread" | "settings" | "stats" | "mosaic" | "invalid";
export type WorkbenchSettingsScope = "global" | "project";

export interface WorkbenchRoute {
  error: string;
  filePath: string;
  mosaicNode: WorkbenchMosaicNode | null;
  projectId: string;
  settingsScope: WorkbenchSettingsScope;
  threadId: string;
  threadOwnerProjectId: string;
  threadTarget: WorkbenchThreadTarget | null;
  view: WorkbenchRouteView;
}

export type WorkbenchRouteParseResult = WorkbenchRoute;
type DecodedRouteSegment = { ok: true; value: string } | { error: string; ok: false };
type DecodedRouteSegments = { ok: true; value: string[] } | { error: string; ok: false };
type WorkbenchLocationLike = {
  pathname: string;
  search: string;
};

export function createHomeRoute(): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    mosaicNode: null,
    projectId: "",
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "home",
  };
}

export function createProjectRoute(projectId: string): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    mosaicNode: null,
    projectId,
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "project",
  };
}

export function createFileRoute(projectId: string, filePath: string): WorkbenchRoute {
  return {
    error: "",
    filePath,
    mosaicNode: null,
    projectId,
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "file",
  };
}

export function createThreadRoute(projectId: string, target: string | WorkbenchThreadTarget): WorkbenchRoute {
  const threadTarget: WorkbenchThreadTarget = typeof target === "string"
    ? target === "new" ? { kind: "new" } : { kind: "provider", threadId: target }
    : WorkbenchThreadTargetSchema.parse(target);
  return {
    error: "",
    filePath: "",
    mosaicNode: null,
    projectId,
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: getWorkbenchThreadTargetRootId(threadTarget),
    threadOwnerProjectId: projectId,
    threadTarget,
    view: "thread",
  };
}

export function createPinnedThreadRoute(
  projectId: string,
  threadOwnerProjectId: string,
  target: string | WorkbenchThreadTarget,
): WorkbenchRoute {
  return {
    ...createThreadRoute(threadOwnerProjectId, target),
    projectId,
    threadOwnerProjectId,
  };
}

export function createHomeThreadRoute(
  threadOwnerProjectId: string,
  target: string | WorkbenchThreadTarget,
): WorkbenchRoute {
  return createPinnedThreadRoute("", threadOwnerProjectId, target);
}

export function getWorkbenchThreadTargetRootId(target: WorkbenchThreadTarget) {
  if (target.kind === "provider") return target.threadId;
  if (target.kind === "subagent") return target.parentThreadId;
  return target.kind === "draft" ? target.draftId : "new";
}

export function getWorkbenchThreadTargetSelectedId(target: WorkbenchThreadTarget) {
  return target.kind === "subagent" ? target.threadId : getWorkbenchThreadTargetRootId(target);
}

export function getWorkbenchMosaicThreadRootIds(node: WorkbenchMosaicNode | null) {
  const threadIds = new Set<string>();
  const visit = (current: WorkbenchMosaicNode | null) => {
    if (!current) return;
    if (current.type === "split") {
      current.children.forEach(visit);
      return;
    }
    if (current.target.kind !== "thread") return;
    const target = current.target.target;
    if (target.kind === "provider" || target.kind === "subagent") {
      threadIds.add(getWorkbenchThreadTargetRootId(target));
    }
  };
  visit(node);
  return threadIds;
}

export function isWorkbenchThreadTargetSelected(
  target: WorkbenchThreadTarget,
  currentTarget: WorkbenchThreadTarget | null,
) {
  if (!currentTarget) return false;
  if (target.kind === "provider" && currentTarget.kind === "subagent") return target.threadId === currentTarget.parentThreadId
    && (!target.harness || !currentTarget.harness || target.harness === currentTarget.harness);
  if (currentTarget.kind !== target.kind) return false;
  if (target.kind === "new" && currentTarget.kind === "new") return target.folderId === currentTarget.folderId;
  if (target.kind === "draft" && currentTarget.kind === "draft") return target.draftId === currentTarget.draftId;
  return target.kind === "provider" && currentTarget.kind === "provider" && target.threadId === currentTarget.threadId
    && (!target.harness || !currentTarget.harness || target.harness === currentTarget.harness);
}

export function isWorkbenchRouteOwnerOfThread(route: WorkbenchRoute, threadId: string, isDraft = false) {
  if (route.view !== "thread" || !route.threadTarget) return false;
  const target = route.threadTarget;
  if (target.kind === "new") return isDraft;
  if (target.kind === "draft") return threadId === target.draftId;
  if (target.kind === "provider") return threadId === target.threadId;
  return threadId === target.threadId || threadId === target.parentThreadId;
}

export function createSettingsRoute(projectId: string, settingsScope: WorkbenchSettingsScope = DEFAULT_SETTINGS_SCOPE): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    mosaicNode: null,
    projectId,
    settingsScope,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "settings",
  };
}

export function createStatsRoute(projectId: string | null = null): WorkbenchRoute {
  return { ...createProjectRoute(projectId ?? ""), view: "stats" };
}

export function createMosaicRoute(projectId: string, mosaicNode: WorkbenchMosaicNode): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    mosaicNode,
    projectId,
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "mosaic",
  };
}

export function createInvalidWorkbenchRoute(error: string, projectId = ""): WorkbenchRoute {
  return {
    error,
    filePath: "",
    mosaicNode: null,
    projectId,
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "invalid",
  };
}

function encodeRouteSegment(value: string) {
  return encodeURIComponent(value);
}

function decodeRouteSegment(value: string): DecodedRouteSegment {
  try {
    return {
      ok: true,
      value: decodeURIComponent(value),
    };
  } catch {
    return {
      error: `Malformed URL segment: ${value}`,
      ok: false,
    };
  }
}

function decodeRouteSegments(segments: string[]): DecodedRouteSegments {
  const decodedSegments: string[] = [];
  for (const segment of segments) {
    const decoded = decodeRouteSegment(segment);
    if (decoded.ok === false) {
      return {
        error: decoded.error,
        ok: false,
      };
    }
    if (decoded.value) {
      decodedSegments.push(decoded.value);
    }
  }

  return {
    ok: true as const,
    value: decodedSegments,
  };
}

function parseSearch(search = "") {
  try {
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return new URLSearchParams();
  }
}

function parseThreadTargetSegments(
  valueSegments: string[],
  projectId: string,
  allowHomeFolderShape = false,
): WorkbenchRoute {
  if (valueSegments[0] === "new") {
    if (valueSegments.length === 1) return createThreadRoute(projectId, { kind: "new" });
    if (valueSegments.length === 2) {
      const draft = WorkbenchThreadTargetSchema.safeParse({ draftId: valueSegments[1], kind: "draft" });
      return draft.success ? createThreadRoute(projectId, draft.data) : createInvalidWorkbenchRoute("Invalid durable draft route.", projectId);
    }
    return createInvalidWorkbenchRoute("Unexpected durable draft route value.", projectId);
  }
  if (
    allowHomeFolderShape
    && valueSegments.length === 4
    && valueSegments[0] === "folder"
    && valueSegments[2] === "thread"
    && valueSegments[3] === "new"
  ) {
    const target = WorkbenchThreadTargetSchema.safeParse({ folderId: valueSegments[1], kind: "new" });
    return target.success ? createThreadRoute(projectId, target.data) : createInvalidWorkbenchRoute("Invalid thread folder route.", projectId);
  }
  if (valueSegments.length === 3 && valueSegments[1] === "sub" && valueSegments[0] && valueSegments[2]) {
    return createThreadRoute(projectId, { kind: "subagent", parentThreadId: valueSegments[0], threadId: valueSegments[2] });
  }
  const value = valueSegments.join("/");
  return valueSegments.length === 1 && value
    ? createThreadRoute(projectId, { kind: "provider", threadId: value })
    : createInvalidWorkbenchRoute("Provider thread IDs must use one segment, or a subagent route must use parent/sub/child.", projectId);
}

function parseLegacyRouteFromSegments(segments: string[], searchParams: URLSearchParams): WorkbenchRoute {
  const markerIndex = segments.indexOf(WORKBENCH_ROUTE_MARKER);
  if (markerIndex >= 0) {
    const projectSegments = decodeRouteSegments(segments.slice(0, markerIndex));
    if (projectSegments.ok === false) {
      return createInvalidWorkbenchRoute(projectSegments.error);
    }

    const mode = segments[markerIndex + 1] ?? "";
    const projectId = projectSegments.value.join("/");
    if (!projectId && !mode && segments.length === 1) {
      return createHomeRoute();
    }
    if (!projectId && mode === "thread") {
      const ownerMarkerIndex = segments.indexOf(WORKBENCH_ROUTE_MARKER, markerIndex + 2);
      if (ownerMarkerIndex < markerIndex + 3) {
        return createInvalidWorkbenchRoute("Home thread routes must identify one owning project.");
      }
      const ownerSegments = decodeRouteSegments(segments.slice(markerIndex + 2, ownerMarkerIndex));
      if (ownerSegments.ok === false) {
        return createInvalidWorkbenchRoute(ownerSegments.error);
      }
      const threadOwnerProjectId = ownerSegments.value.join("/");
      const targetSegments = decodeRouteSegments(segments.slice(ownerMarkerIndex + 1));
      if (targetSegments.ok === false) {
        return createInvalidWorkbenchRoute(targetSegments.error);
      }
      const parsedTarget = parseThreadTargetSegments(targetSegments.value, threadOwnerProjectId, true);
      return parsedTarget.view === "thread" && parsedTarget.threadTarget
        ? createHomeThreadRoute(threadOwnerProjectId, parsedTarget.threadTarget)
        : createInvalidWorkbenchRoute(parsedTarget.error || "Invalid home thread target.");
    }
    if (mode === "pin") {
      const pinnedRoute = parseLegacyRouteFromSegments(segments.slice(markerIndex + 2), new URLSearchParams());
      if (
        pinnedRoute.view !== "thread"
        || !pinnedRoute.projectId
        || !pinnedRoute.threadTarget
        || pinnedRoute.threadOwnerProjectId !== pinnedRoute.projectId
      ) {
        return createInvalidWorkbenchRoute("Pinned routes must contain one canonical owning-project thread route.", projectId);
      }
      return createPinnedThreadRoute(projectId, pinnedRoute.projectId, pinnedRoute.threadTarget);
    }
    if (mode === "mosaic") {
      const parsedMosaic = parseWorkbenchMosaicRouteExpression(segments.slice(markerIndex + 2).join("/"));
      if (parsedMosaic.ok === false) {
        return createProjectRoute(projectId);
      }

      return createMosaicRoute(projectId, parsedMosaic.node);
    }

    const valueSegments = decodeRouteSegments(segments.slice(markerIndex + 2));
    if (valueSegments.ok === false) {
      return createInvalidWorkbenchRoute(valueSegments.error, projectId);
    }

    const value = valueSegments.value.join("/");
    if (mode === "file") {
      return createFileRoute(projectId, value);
    }
    if (mode === "thread") {
      return parseThreadTargetSegments(valueSegments.value, projectId);
    }
    if (mode === "folder") {
      if (valueSegments.value.length !== 3 || valueSegments.value[1] !== "thread" || valueSegments.value[2] !== "new") {
        return createInvalidWorkbenchRoute("Folder routes must identify one blank thread composer.", projectId);
      }
      const target = WorkbenchThreadTargetSchema.safeParse({ folderId: valueSegments.value[0], kind: "new" });
      return target.success ? createThreadRoute(projectId, target.data) : createInvalidWorkbenchRoute("Invalid thread folder route.", projectId);
    }
    if (mode === "settings") {
      if (!valueSegments.value.length) {
        return createSettingsRoute(projectId);
      }

      const settingsScope = valueSegments.value[0];
      if (settingsScope !== "global" && settingsScope !== "project") {
        return createInvalidWorkbenchRoute(`Unknown settings scope: ${settingsScope}`, projectId);
      }
      if (valueSegments.value.length > 1) {
        return createInvalidWorkbenchRoute(`Unexpected settings route value: ${value}`, projectId);
      }

      return createSettingsRoute(projectId, settingsScope);
    }
    if (mode === "stats") {
      return valueSegments.value.length
        ? createInvalidWorkbenchRoute(`Unexpected stats route value: ${value}`, projectId)
        : createStatsRoute(projectId);
    }
    return createInvalidWorkbenchRoute(`Unknown workbench route mode: ${mode}`, projectId);
  }

  const projectSegments = decodeRouteSegments(segments);
  if (projectSegments.ok === false) {
    return createInvalidWorkbenchRoute(projectSegments.error);
  }

  const projectId = projectSegments.value.join("/");
  const legacyThreadId = searchParams.get(LEGACY_THREAD_SEARCH_PARAM);
  if (legacyThreadId) {
    return createThreadRoute(projectId, legacyThreadId);
  }

  const legacyFilePath = searchParams.get(LEGACY_FILE_SEARCH_PARAM);
  if (legacyFilePath) {
    return createFileRoute(projectId, legacyFilePath);
  }

  return createProjectRoute(projectId);
}

export function parseWorkbenchRouteFromPath(pathname: string, search = ""): WorkbenchRouteParseResult {
  const searchParams = parseSearch(search);
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (!segments.length) {
    const legacyThreadId = searchParams.get(LEGACY_THREAD_SEARCH_PARAM);
    if (legacyThreadId) {
      return createThreadRoute("", legacyThreadId);
    }
    const legacyFilePath = searchParams.get(LEGACY_FILE_SEARCH_PARAM);
    if (legacyFilePath) {
      return createFileRoute("", legacyFilePath);
    }
    return createHomeRoute();
  }

  return parseLegacyRouteFromSegments(segments, searchParams);
}

export function parseWorkbenchRouteFromLocation(location: WorkbenchLocationLike | string): WorkbenchRouteParseResult {
  if (typeof location === "string") {
    try {
      const url = new URL(location, "http://workbench.local");
      return parseWorkbenchRouteFromPath(url.pathname, url.search);
    } catch {
      return createInvalidWorkbenchRoute("Malformed workbench URL.");
    }
  }

  return parseWorkbenchRouteFromPath(location.pathname, location.search);
}

export function createWorkbenchHref(route: WorkbenchRoute): string {
  const projectPath = encodeWorkbenchRoutePath(route.projectId);
  const markedPath = projectPath ? `/${projectPath}/${WORKBENCH_ROUTE_MARKER}` : `/${WORKBENCH_ROUTE_MARKER}`;
  if (route.view === "home") {
    return `/${WORKBENCH_ROUTE_MARKER}/`;
  }
  if (route.view === "file") {
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/file/${encodeWorkbenchRoutePath(route.filePath)}`;
  }
  if (route.view === "thread") {
    const target = route.threadTarget ?? (route.threadId === "new" ? { kind: "new" as const } : { kind: "provider" as const, threadId: route.threadId });
    const threadOwnerProjectId = route.threadOwnerProjectId || route.projectId;
    if (!route.projectId && threadOwnerProjectId) {
      const ownerPath = encodeWorkbenchRoutePath(threadOwnerProjectId);
      if (target.kind === "new") return target.folderId
        ? `/${WORKBENCH_ROUTE_MARKER}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/folder/${target.folderId}/thread/new`
        : `/${WORKBENCH_ROUTE_MARKER}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/new`;
      if (target.kind === "draft") return `/${WORKBENCH_ROUTE_MARKER}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/new/${target.draftId}`;
      if (target.kind === "subagent") return `/${WORKBENCH_ROUTE_MARKER}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/${encodeRouteSegment(target.parentThreadId)}/sub/${encodeRouteSegment(target.threadId)}`;
      return `/${WORKBENCH_ROUTE_MARKER}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/${encodeRouteSegment(target.threadId)}`;
    }
    if (threadOwnerProjectId !== route.projectId) {
      return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/pin${createWorkbenchHref(createThreadRoute(threadOwnerProjectId, target))}`;
    }
    if (target.kind === "new") return target.folderId
      ? `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/folder/${target.folderId}/thread/new`
      : `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/new`;
    if (target.kind === "draft") return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/new/${target.draftId}`;
    if (target.kind === "subagent") return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/${encodeRouteSegment(target.parentThreadId)}/sub/${encodeRouteSegment(target.threadId)}`;
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/${encodeRouteSegment(target.threadId)}`;
  }
  if (route.view === "settings") {
    return `${markedPath}/settings/${route.settingsScope}`;
  }
  if (route.view === "stats") {
    return `${markedPath}/stats`;
  }
  if (route.view === "mosaic" && route.mosaicNode) {
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/mosaic/${serializeWorkbenchMosaicRouteExpression(route.mosaicNode)}`;
  }

  return createWorkbenchProjectHref(route.projectId);
}

export function createProjectHref(projectId: string) {
  return createWorkbenchProjectHref(projectId);
}

export function createHomeHref() {
  return createWorkbenchHref(createHomeRoute());
}

export function createFileHref(projectId: string, filePath: string) {
  return createWorkbenchHref(createFileRoute(projectId, filePath));
}

export function createThreadHref(projectId: string, target: string | WorkbenchThreadTarget) {
  return createWorkbenchHref(createThreadRoute(projectId, target));
}

export function createPinnedThreadHref(projectId: string, threadOwnerProjectId: string, target: string | WorkbenchThreadTarget) {
  return createWorkbenchHref(createPinnedThreadRoute(projectId, threadOwnerProjectId, target));
}

export function createHomeThreadHref(threadOwnerProjectId: string, target: string | WorkbenchThreadTarget) {
  return createWorkbenchHref(createHomeThreadRoute(threadOwnerProjectId, target));
}

export function createSettingsHref(projectId: string, settingsScope: WorkbenchSettingsScope = DEFAULT_SETTINGS_SCOPE) {
  return createWorkbenchHref(createSettingsRoute(projectId, settingsScope));
}

export function createStatsHref(projectId: string | null = null) {
  return createWorkbenchHref(createStatsRoute(projectId));
}

export function createMosaicHref(projectId: string, mosaicNode: WorkbenchMosaicNode) {
  return createWorkbenchHref(createMosaicRoute(projectId, mosaicNode));
}

export function isSameWorkbenchRoute(left: WorkbenchRoute, right: WorkbenchRoute) {
  return left.view === right.view
    && left.projectId === right.projectId
    && left.filePath === right.filePath
    && areDeeplyEqual(left.mosaicNode, right.mosaicNode)
    && left.settingsScope === right.settingsScope
    && left.threadId === right.threadId
    && left.threadOwnerProjectId === right.threadOwnerProjectId
    && areDeeplyEqual(left.threadTarget, right.threadTarget)
    && left.error === right.error;
}

export function routeHasSelection(route: WorkbenchRoute) {
  return route.view === "file" || route.view === "thread" || route.view === "mosaic";
}
