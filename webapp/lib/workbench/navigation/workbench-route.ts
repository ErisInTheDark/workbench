/*
 * Exports:
 * - WORKBENCH_ROUTE_MARKER: route marker for canonical workbench URLs. Keywords: URL, route, navigation.
 * - WorkbenchRouteView, WorkbenchSettingsScope, WorkbenchRoute, WorkbenchRouteParseResult: normalized route contracts. Keywords: URL source of truth, project, file, thread, settings, mosaic.
 * - createProjectRoute/createFileRoute/createThreadRoute/createSettingsRoute/createMosaicRoute/createInvalidWorkbenchRoute: construct route objects. Keywords: navigation, route builder.
 * - getWorkbenchDraftIdFromThreadId/getWorkbenchThreadTargetRootId/getWorkbenchThreadTargetSelectedId/isWorkbenchThreadTargetSelected: derive durable draft, parent hydration, selected tab identity, and sidebar selection. Keywords: thread, draft, subagent, parent.
 * - parseWorkbenchRouteFromLocation/parseWorkbenchRouteFromPath: parse browser URL state without mutating history. Keywords: route parser, legacy query, malformed URL.
 * - createWorkbenchHref/createProjectHref/createFileHref/createThreadHref/createSettingsHref: build canonical hrefs. Keywords: links, URL, encode.
 * - isSameWorkbenchRoute/routeHasSelection/isWorkbenchRouteOwnerOfThread: compare, classify, and fence route-owned thread transitions. Keywords: route equality, active selection, draft promotion.
 */

import {
  parseWorkbenchMosaicRouteExpression,
  serializeWorkbenchMosaicRouteExpression,
  type WorkbenchMosaicNode,
} from "./workbench-mosaic-route";
import { areDeeplyEqual } from "../deep-equality";
import { WorkbenchThreadTargetSchema, type WorkbenchThreadTarget } from "../thread/thread-state";

export const WORKBENCH_ROUTE_MARKER = "@";

const LEGACY_FILE_SEARCH_PARAM = "file";
const LEGACY_THREAD_SEARCH_PARAM = "thread";
const DEFAULT_SETTINGS_SCOPE: WorkbenchSettingsScope = "global";

export type WorkbenchRouteView = "project" | "file" | "thread" | "settings" | "mosaic" | "invalid";
export type WorkbenchSettingsScope = "global" | "project";

export interface WorkbenchRoute {
  error: string;
  filePath: string;
  mosaicNode: WorkbenchMosaicNode | null;
  projectId: string;
  settingsScope: WorkbenchSettingsScope;
  threadId: string;
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

function emptyProjectRoute(): WorkbenchRoute {
  return createProjectRoute("");
}

export function createProjectRoute(projectId: string): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    mosaicNode: null,
    projectId,
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: "",
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
    threadTarget,
    view: "thread",
  };
}

export function getWorkbenchThreadTargetRootId(target: WorkbenchThreadTarget) {
  if (target.kind === "provider") return target.threadId;
  if (target.kind === "subagent") return target.parentThreadId;
  return target.kind === "draft" ? `draft:${target.draftId}` : "new";
}

export function getWorkbenchThreadTargetSelectedId(target: WorkbenchThreadTarget) {
  return target.kind === "subagent" ? target.threadId : getWorkbenchThreadTargetRootId(target);
}

export function isWorkbenchThreadTargetSelected(
  target: WorkbenchThreadTarget,
  currentTarget: WorkbenchThreadTarget | null,
) {
  if (!currentTarget) return false;
  if (target.kind === "provider" && currentTarget.kind === "subagent") return target.threadId === currentTarget.parentThreadId
    && (!target.harness || !currentTarget.harness || target.harness === currentTarget.harness);
  if (currentTarget.kind !== target.kind) return false;
  if (target.kind === "new") return true;
  if (target.kind === "draft" && currentTarget.kind === "draft") return target.draftId === currentTarget.draftId;
  return target.kind === "provider" && currentTarget.kind === "provider" && target.threadId === currentTarget.threadId
    && (!target.harness || !currentTarget.harness || target.harness === currentTarget.harness);
}

export function getWorkbenchDraftIdFromThreadId(threadId: string) {
  if (!threadId.startsWith("draft:")) return null;
  const parsed = WorkbenchThreadTargetSchema.safeParse({ draftId: threadId.slice("draft:".length), kind: "draft" });
  return parsed.success && parsed.data.kind === "draft" ? parsed.data.draftId : null;
}

export function isWorkbenchRouteOwnerOfThread(route: WorkbenchRoute, threadId: string) {
  if (route.view !== "thread" || !route.threadTarget) return false;
  const target = route.threadTarget;
  if (target.kind === "new") return threadId.startsWith("draft:");
  if (target.kind === "draft") return threadId === `draft:${target.draftId}`;
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
    threadTarget: null,
    view: "settings",
  };
}

export function createMosaicRoute(projectId: string, mosaicNode: WorkbenchMosaicNode): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    mosaicNode,
    projectId,
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: "",
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
    threadTarget: null,
    view: "invalid",
  };
}

function encodeRouteSegment(value: string) {
  return encodeURIComponent(value);
}

function encodeRoutePath(value: string) {
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeRouteSegment(segment))
    .join("/");
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

function parseLegacyRouteFromSegments(segments: string[], searchParams: URLSearchParams): WorkbenchRoute {
  const markerIndex = segments.indexOf(WORKBENCH_ROUTE_MARKER);
  if (markerIndex >= 0) {
    const projectSegments = decodeRouteSegments(segments.slice(0, markerIndex));
    if (projectSegments.ok === false) {
      return createInvalidWorkbenchRoute(projectSegments.error);
    }

    const mode = segments[markerIndex + 1] ?? "";
    const projectId = projectSegments.value.join("/");
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
      if (valueSegments.value[0] === "new") {
        if (valueSegments.value.length === 1) return createThreadRoute(projectId, { kind: "new" });
        if (valueSegments.value.length === 2) {
          const draft = WorkbenchThreadTargetSchema.safeParse({ draftId: valueSegments.value[1], kind: "draft" });
          return draft.success ? createThreadRoute(projectId, draft.data) : createInvalidWorkbenchRoute("Invalid durable draft route.", projectId);
        }
        return createInvalidWorkbenchRoute("Unexpected durable draft route value.", projectId);
      }
      if (valueSegments.value.length === 3 && valueSegments.value[1] === "sub" && valueSegments.value[0] && valueSegments.value[2]) {
        return createThreadRoute(projectId, { kind: "subagent", parentThreadId: valueSegments.value[0], threadId: valueSegments.value[2] });
      }
      return valueSegments.value.length === 1 && value ? createThreadRoute(projectId, { kind: "provider", threadId: value }) : createInvalidWorkbenchRoute("Provider thread IDs must use one segment, or a subagent route must use parent/sub/child.", projectId);
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
    return emptyProjectRoute();
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

export function createWorkbenchHref(route: WorkbenchRoute) {
  const projectPath = encodeRoutePath(route.projectId);
  if (route.view === "file") {
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/file/${encodeRoutePath(route.filePath)}`;
  }
  if (route.view === "thread") {
    const target = route.threadTarget ?? (route.threadId === "new" ? { kind: "new" as const } : { kind: "provider" as const, threadId: route.threadId });
    if (target.kind === "new") return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/new`;
    if (target.kind === "draft") return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/new/${target.draftId}`;
    if (target.kind === "subagent") return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/${encodeRouteSegment(target.parentThreadId)}/sub/${encodeRouteSegment(target.threadId)}`;
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/${encodeRouteSegment(target.threadId)}`;
  }
  if (route.view === "settings") {
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/settings/${route.settingsScope}`;
  }
  if (route.view === "mosaic" && route.mosaicNode) {
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/mosaic/${serializeWorkbenchMosaicRouteExpression(route.mosaicNode)}`;
  }

  return projectPath ? `/${projectPath}` : "/";
}

export function createProjectHref(projectId: string) {
  return createWorkbenchHref(createProjectRoute(projectId));
}

export function createFileHref(projectId: string, filePath: string) {
  return createWorkbenchHref(createFileRoute(projectId, filePath));
}

export function createThreadHref(projectId: string, target: string | WorkbenchThreadTarget) {
  return createWorkbenchHref(createThreadRoute(projectId, target));
}

export function createSettingsHref(projectId: string, settingsScope: WorkbenchSettingsScope = DEFAULT_SETTINGS_SCOPE) {
  return createWorkbenchHref(createSettingsRoute(projectId, settingsScope));
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
    && areDeeplyEqual(left.threadTarget, right.threadTarget)
    && left.error === right.error;
}

export function routeHasSelection(route: WorkbenchRoute) {
  return route.view === "file" || route.view === "thread" || route.view === "mosaic";
}
