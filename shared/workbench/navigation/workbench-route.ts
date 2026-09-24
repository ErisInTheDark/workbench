/*
 * Exports:
 * - WORKBENCH_ROUTE_MARKER: route marker for workbench URLs.
 * - WorkbenchRouteView/WorkbenchSettingsScope/WorkbenchRoute/WorkbenchRouteParseResult: normalized route contracts.
 * - createHomeRoute/createProjectRoute/createFileRoute/createThreadRoute/createPinnedThreadRoute/createHomeThreadRoute/createSettingsRoute/createStatsRoute/createGitRoute/createMosaicRoute/createInvalidWorkbenchRoute: construct routes.
 * - createLogicalProjectRoute/createLogicalFileRoute/createLogicalGitRoute/createLogicalThreadRoute/createLogicalExistingThreadRoute/createLogicalMosaicRoute: v2 project, target and UUID routes.
 * - getWorkbenchThreadTargetRootId/getWorkbenchThreadTargetSelectedId/getWorkbenchMosaicThreadRootIds/isWorkbenchThreadTargetSelected: derive hydration and selection identities.
 * - parseWorkbenchRouteFromLocation/parseWorkbenchRouteFromPath: parse URL state without changing history.
 * - createWorkbenchHref/createHomeHref/createProjectHref/createFileHref/createThreadHref/createPinnedThreadHref/createHomeThreadHref/createSettingsHref/createStatsHref/createMosaicHref: build hrefs.
 * - isSameWorkbenchRoute/routeHasSelection/isWorkbenchRouteOwnerOfThread: compare and fence route-owned transitions.
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
import { z } from "zod";
import { WorkbenchThreadRouteTargetSchema, type WorkbenchThreadRouteTarget } from "../thread/thread-state.ts";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, type LogicalProjectId, type ProjectId } from "../identity.ts";
import { ProjectLocationReferenceSchema, type ProjectLocationReference } from "../project/project-location.ts";

export const WORKBENCH_ROUTE_MARKER = "@";

const LEGACY_FILE_SEARCH_PARAM = "file";
const LEGACY_THREAD_SEARCH_PARAM = "thread";
const DEFAULT_SETTINGS_SCOPE: WorkbenchSettingsScope = "global";
const RouteThreadReferenceSchema = z.string().brand<"ThreadReference">();
const RouteProjectIdSchema = z.string().brand<"ProjectId">();

export type WorkbenchRouteView = "home" | "project" | "file" | "thread" | "settings" | "stats" | "git" | "mosaic" | "invalid";
export type WorkbenchSettingsScope = "global" | "project";

export interface WorkbenchRoute {
  error: string;
  filePath: string;
  mosaicNode: WorkbenchMosaicNode | null;
  projectId: ProjectId | "";
  settingsScope: WorkbenchSettingsScope;
  threadId: string;
  threadOwnerProjectId: ProjectId | "";
  threadTarget: WorkbenchThreadRouteTarget | null;
  logical?: {
    projectId: LogicalProjectId | null;
    threadOwnerProjectId: LogicalProjectId | null;
    location: ProjectLocationReference | null;
    browseLocation?: ProjectLocationReference | null;
    legacyOwnerLocation?: ProjectLocationReference | null;
  };
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
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "project",
  };
}

export function createLogicalProjectRoute(logicalProjectId: string, location: ProjectLocationReference | null = null): WorkbenchRoute {
  return { ...createProjectRoute(""), logical: {
    projectId: LogicalProjectIdSchema.parse(logicalProjectId),
    threadOwnerProjectId: null,
    location: location ? ProjectLocationReferenceSchema.parse(location) : null,
    browseLocation: null,
  } };
}

export function createLogicalGitRoute(logicalProjectId: string, location: ProjectLocationReference): WorkbenchRoute {
  return { ...createLogicalProjectRoute(logicalProjectId, location), view: "git" };
}

export function createLogicalFileRoute(logicalProjectId: string, location: ProjectLocationReference, filePath: string): WorkbenchRoute {
  return { ...createLogicalProjectRoute(logicalProjectId, location), view: "file", filePath };
}

export function createLogicalThreadRoute(
  selectedLogicalProjectId: string | null,
  ownerLogicalProjectId: string,
  location: ProjectLocationReference | null,
  target: string | WorkbenchThreadRouteTarget,
  browseLocation: ProjectLocationReference | null = null,
): WorkbenchRoute {
  const route = createThreadRoute("", target);
  if ((route.threadTarget?.kind === "provider" || route.threadTarget?.kind === "subagent") && !location) {
    throw new Error("Materialized threads require a concrete daemon location.");
  }
  return { ...route, logical: {
    projectId: selectedLogicalProjectId ? LogicalProjectIdSchema.parse(selectedLogicalProjectId) : null,
    threadOwnerProjectId: LogicalProjectIdSchema.parse(ownerLogicalProjectId),
    location: location ? ProjectLocationReferenceSchema.parse(location) : null,
    browseLocation: browseLocation ? ProjectLocationReferenceSchema.parse(browseLocation) : null,
  } };
}

export function createLogicalExistingThreadRoute(
  selectedLogicalProjectId: string | null,
  target: Extract<WorkbenchThreadRouteTarget, { kind: "provider" | "subagent" }>,
  browseLocation: ProjectLocationReference | null = null,
): WorkbenchRoute {
  const route = createThreadRoute("", target);
  return { ...route, logical: {
    projectId: selectedLogicalProjectId ? LogicalProjectIdSchema.parse(selectedLogicalProjectId) : null,
    threadOwnerProjectId: null,
    location: null,
    browseLocation: browseLocation ? ProjectLocationReferenceSchema.parse(browseLocation) : null,
    legacyOwnerLocation: null,
  } };
}

function mosaicPanesHaveSources(node: WorkbenchMosaicNode): boolean {
  if (node.type === "split") return node.children.every(mosaicPanesHaveSources);
  if (node.target.kind === "thread"
    && (node.target.target.kind === "provider" || node.target.target.kind === "subagent")) return true;
  const source = node.target.source;
  return Boolean(source && (node.target.kind === "thread" || source.location));
}

export function createLogicalMosaicRoute(logicalProjectId: string, mosaicNode: WorkbenchMosaicNode): WorkbenchRoute {
  if (!mosaicPanesHaveSources(mosaicNode)) throw new Error("Logical mosaic panes require source addresses.");
  return { ...createMosaicRoute("", mosaicNode), logical: {
    projectId: LogicalProjectIdSchema.parse(logicalProjectId),
    threadOwnerProjectId: null,
    location: null,
    browseLocation: null,
  } };
}

export function createGitRoute(projectId: string): WorkbenchRoute {
  return { ...createProjectRoute(projectId), view: "git" };
}

export function createFileRoute(projectId: string, filePath: string): WorkbenchRoute {
  return {
    error: "",
    filePath,
    mosaicNode: null,
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "file",
  };
}

export function createThreadRoute(projectId: string, target: string | WorkbenchThreadRouteTarget): WorkbenchRoute {
  const threadTarget: WorkbenchThreadRouteTarget = typeof target === "string"
    ? target === "new" ? { kind: "new" } : { kind: "provider", threadId: RouteThreadReferenceSchema.parse(target) }
    : WorkbenchThreadRouteTargetSchema.parse(target);
  return {
    error: "",
    filePath: "",
    mosaicNode: null,
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
    settingsScope: DEFAULT_SETTINGS_SCOPE,
    threadId: getWorkbenchThreadTargetRootId(threadTarget),
    threadOwnerProjectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
    threadTarget,
    view: "thread",
  };
}

export function createPinnedThreadRoute(
  projectId: string,
  threadOwnerProjectId: string,
  target: string | WorkbenchThreadRouteTarget,
): WorkbenchRoute {
  return {
    ...createThreadRoute(threadOwnerProjectId, target),
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
    threadOwnerProjectId: threadOwnerProjectId ? RouteProjectIdSchema.parse(threadOwnerProjectId) : "",
  };
}

export function createHomeThreadRoute(
  threadOwnerProjectId: string,
  target: string | WorkbenchThreadRouteTarget,
): WorkbenchRoute {
  return createPinnedThreadRoute("", threadOwnerProjectId, target);
}

export function getWorkbenchThreadTargetRootId(target: WorkbenchThreadRouteTarget) {
  if (target.kind === "provider") return target.threadId;
  if (target.kind === "subagent") return target.parentThreadId;
  return target.kind === "draft" ? target.draftId : "new";
}

export function getWorkbenchThreadTargetSelectedId(target: WorkbenchThreadRouteTarget) {
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
  target: WorkbenchThreadRouteTarget,
  currentTarget: WorkbenchThreadRouteTarget | null,
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

export function isWorkbenchRouteOwnerOfThread(
  route: WorkbenchRoute, threadId: string, isDraft = false, location?: ProjectLocationReference,
) {
  if (route.view !== "thread" || !route.threadTarget) return false;
  const target = route.threadTarget;
  if (route.logical && (target.kind === "provider" || target.kind === "subagent")) {
    const owner = route.logical.legacyOwnerLocation;
    if (owner && (!location || owner.daemonId !== location.daemonId || owner.projectId !== location.projectId)) return false;
  }
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
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
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
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
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
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
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
      const draft = WorkbenchThreadRouteTargetSchema.safeParse({ draftId: valueSegments[1], kind: "draft" });
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
    const target = WorkbenchThreadRouteTargetSchema.safeParse({ folderId: valueSegments[1], kind: "new" });
    return target.success ? createThreadRoute(projectId, target.data) : createInvalidWorkbenchRoute("Invalid thread folder route.", projectId);
  }
  if (valueSegments.length === 3 && valueSegments[1] === "sub" && valueSegments[0] && valueSegments[2]) {
    return createThreadRoute(projectId, { kind: "subagent", parentThreadId: RouteThreadReferenceSchema.parse(valueSegments[0]), threadId: RouteThreadReferenceSchema.parse(valueSegments[2]) });
  }
  const value = valueSegments.join("/");
  return valueSegments.length === 1 && value
    ? createThreadRoute(projectId, { kind: "provider", threadId: RouteThreadReferenceSchema.parse(value) })
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
      const target = WorkbenchThreadRouteTargetSchema.safeParse({ folderId: valueSegments.value[0], kind: "new" });
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
    if (mode === "git") {
      return projectId && !valueSegments.value.length
        ? createGitRoute(projectId)
        : createInvalidWorkbenchRoute("Git routes require one project and no extra segments.", projectId);
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

  if (segments[0] === WORKBENCH_ROUTE_MARKER && segments[1] === "v2") {
    return parseLogicalRoute(segments.slice(2));
  }
  return parseLegacyRouteFromSegments(segments, searchParams);
}

function parseLogicalRoute(rawSegments: string[]): WorkbenchRoute {
  if (rawSegments[0] === "p" && rawSegments[2] === "mosaic") {
    const projectSegment = decodeRouteSegment(rawSegments[1] ?? "");
    const project = projectSegment.ok ? LogicalProjectIdSchema.safeParse(projectSegment.value) : null;
    const mosaic = parseWorkbenchMosaicRouteExpression(rawSegments.slice(3).join("/"));
    return project?.success && mosaic.ok && mosaicPanesHaveSources(mosaic.node)
      ? createLogicalMosaicRoute(project.data, mosaic.node)
      : createInvalidWorkbenchRoute("Invalid logical mosaic route.");
  }
  const decoded = decodeRouteSegments(rawSegments);
  if (decoded.ok === false) return createInvalidWorkbenchRoute(decoded.error);
  const segments = decoded.value;
  const home = segments[0] === "home";
  const selectedResult = LogicalProjectIdSchema.safeParse(segments[1]);
  if (!home && (segments[0] !== "p" || !selectedResult.success)) {
    return createInvalidWorkbenchRoute("Logical routes require a project or home.");
  }
  const selected = home ? null : selectedResult.data ?? null;
  const tail = segments.slice(home ? 1 : 2);
  if (!tail.length && selected) return createLogicalProjectRoute(selected);
  if (tail[0] === "browse" && selected) {
    const daemonId = DaemonIdSchema.safeParse(tail[1]);
    const projectId = ProjectIdSchema.safeParse(tail[2]);
    if (!daemonId.success || !projectId.success) return createInvalidWorkbenchRoute("Invalid browse location.");
    const location = { daemonId: daemonId.data, projectId: projectId.data };
    if (tail.length === 3) return createLogicalProjectRoute(selected, location);
    if (tail.length === 4 && tail[3] === "git") return createLogicalGitRoute(selected, location);
    if (tail.length >= 5 && tail[3] === "file") {
      return createLogicalFileRoute(selected, location, tail.slice(4).join("/"));
    }
    return createInvalidWorkbenchRoute("Invalid browse route.");
  }
  if (tail[0] !== "thread") return createInvalidWorkbenchRoute("Unknown logical route.");
  if (tail[1] === "id") {
    const browseAt = tail.indexOf("browse", 2);
    const identityTail = browseAt < 0 ? tail : tail.slice(0, browseAt);
    const browse = browseAt < 0 ? null : ProjectLocationReferenceSchema.safeParse({
      daemonId: tail[browseAt + 1], projectId: tail[browseAt + 2],
    });
    if (browseAt >= 0 && (tail.length !== browseAt + 3 || !browse?.success)) {
      return createInvalidWorkbenchRoute("Invalid thread browse location.");
    }
    const candidate = identityTail.length === 3
      ? { kind: "provider", threadId: identityTail[2] }
      : identityTail.length === 5 && identityTail[3] === "sub"
        ? { kind: "subagent", parentThreadId: identityTail[2], threadId: identityTail[4] }
        : null;
    const parsed = WorkbenchThreadRouteTargetSchema.safeParse(candidate);
    return parsed.success && (parsed.data.kind === "provider" || parsed.data.kind === "subagent")
      ? createLogicalExistingThreadRoute(selected, parsed.data, browse?.success ? browse.data : null)
      : createInvalidWorkbenchRoute("Invalid UUID thread route.");
  }
  const owner = LogicalProjectIdSchema.safeParse(tail[1]);
  if (!owner.success) return createInvalidWorkbenchRoute("Invalid thread project identity.");
  const target = tail.slice(2);
  if (target[0] === "new" && (target.length === 1 || target.length === 3 && target[1] === "folder"
    || target.length === 4 && target[1] === "at"
    || target.length === 6 && target[1] === "folder" && target[3] === "at")) {
    const parsed = WorkbenchThreadRouteTargetSchema.safeParse(
      target[1] === "folder" ? { kind: "new", folderId: target[2] } : { kind: "new" },
    );
    const at = target[1] === "at" ? 1 : target[3] === "at" ? 3 : -1;
    const daemonId = at < 0 ? null : DaemonIdSchema.safeParse(target[at + 1]);
    const projectId = at < 0 ? null : ProjectIdSchema.safeParse(target[at + 2]);
    return parsed.success && (at < 0 || daemonId?.success && projectId?.success)
      ? createLogicalThreadRoute(selected, owner.data,
        daemonId?.success && projectId?.success ? { daemonId: daemonId.data, projectId: projectId.data } : null,
        parsed.data)
      : createInvalidWorkbenchRoute("Invalid logical new-thread route.");
  }
  if (target[0] === "draft" && (target.length === 2 || target.length === 5 && target[2] === "at")) {
    const parsed = WorkbenchThreadRouteTargetSchema.safeParse({ kind: "draft", draftId: target[1] });
    const daemonId = target.length === 5 ? DaemonIdSchema.safeParse(target[3]) : null;
    const projectId = target.length === 5 ? ProjectIdSchema.safeParse(target[4]) : null;
    return parsed.success && (target.length === 2 || daemonId?.success && projectId?.success)
      ? createLogicalThreadRoute(selected, owner.data,
        daemonId?.success && projectId?.success ? { daemonId: daemonId.data, projectId: projectId.data } : null,
        parsed.data)
      : createInvalidWorkbenchRoute("Invalid logical draft.");
  }
  if (target[0] === "at" && (target.length === 4 || target.length === 6 && target[4] === "sub")) {
    const daemonId = DaemonIdSchema.safeParse(target[1]);
    const projectId = ProjectIdSchema.safeParse(target[2]);
    if (!daemonId.success || !projectId.success) return createInvalidWorkbenchRoute("Invalid thread location.");
    const candidate = target.length === 4
      ? { kind: "provider", threadId: target[3] }
      : { kind: "subagent", parentThreadId: target[3], threadId: target[5] };
    const parsed = WorkbenchThreadRouteTargetSchema.safeParse(candidate);
    return parsed.success && (parsed.data.kind === "provider" || parsed.data.kind === "subagent") ? {
      ...createLogicalExistingThreadRoute(selected, parsed.data),
      logical: {
        projectId: selected,
        threadOwnerProjectId: null,
        location: null,
        browseLocation: null,
        legacyOwnerLocation: { daemonId: daemonId.data, projectId: projectId.data },
      },
    }
      : createInvalidWorkbenchRoute("Invalid logical thread.");
  }
  return createInvalidWorkbenchRoute("Invalid logical thread route.");
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
  if (route.logical) return createLogicalHref(route);
  const projectPath = encodeWorkbenchRoutePath(route.projectId);
  const markedPath = projectPath ? `/${projectPath}/${WORKBENCH_ROUTE_MARKER}` : `/${WORKBENCH_ROUTE_MARKER}`;
  if (route.view === "home") {
    return `/${WORKBENCH_ROUTE_MARKER}/`;
  }
  if (route.view === "file") {
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/file/${encodeWorkbenchRoutePath(route.filePath)}`;
  }
  if (route.view === "thread") {
    const target = route.threadTarget ?? (route.threadId === "new" ? { kind: "new" as const } : { kind: "provider" as const, threadId: RouteThreadReferenceSchema.parse(route.threadId) });
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
  if (route.view === "git") return `${markedPath}/git`;
  if (route.view === "stats") {
    return `${markedPath}/stats`;
  }
  if (route.view === "mosaic" && route.mosaicNode) {
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/mosaic/${serializeWorkbenchMosaicRouteExpression(route.mosaicNode)}`;
  }

  return createWorkbenchProjectHref(route.projectId);
}

function createLogicalHref(route: WorkbenchRoute): string {
  const logical = route.logical!;
  const base = `/${WORKBENCH_ROUTE_MARKER}/v2/${logical.projectId ? `p/${encodeRouteSegment(logical.projectId)}` : "home"}`;
  const location = logical.location
    ? `${encodeRouteSegment(logical.location.daemonId)}/${encodeRouteSegment(logical.location.projectId)}` : null;
  if (route.view === "project" && logical.projectId) return location ? `${base}/browse/${location}` : base;
  if (route.view === "git" && location) return `${base}/browse/${location}/git`;
  if (route.view === "file" && location) return `${base}/browse/${location}/file/${encodeRouteSegment(route.filePath)}`;
  if (route.view === "mosaic" && route.mosaicNode) {
    return `${base}/mosaic/${serializeWorkbenchMosaicRouteExpression(route.mosaicNode)}`;
  }
  if (route.view === "thread" && route.threadTarget
    && (route.threadTarget.kind === "provider" || route.threadTarget.kind === "subagent")
    && !logical.threadOwnerProjectId) {
    const target = route.threadTarget;
    const threadHref = target.kind === "provider"
      ? `${base}/thread/id/${encodeRouteSegment(target.threadId)}`
      : `${base}/thread/id/${encodeRouteSegment(target.parentThreadId)}/sub/${encodeRouteSegment(target.threadId)}`;
    const browse = logical.browseLocation;
    return browse ? `${threadHref}/browse/${encodeRouteSegment(browse.daemonId)}/${encodeRouteSegment(browse.projectId)}`
      : threadHref;
  }
  if (route.view === "thread" && logical.threadOwnerProjectId && route.threadTarget) {
    const threadBase = `${base}/thread/${encodeRouteSegment(logical.threadOwnerProjectId)}`;
    const target = route.threadTarget;
    if (target.kind === "new") return `${threadBase}/new${target.folderId
      ? `/folder/${encodeRouteSegment(target.folderId)}` : ""}${location ? `/at/${location}` : ""}`;
    if (target.kind === "draft") return `${threadBase}/draft/${encodeRouteSegment(target.draftId)}`;
    if (!location) throw new Error("Materialized thread route has no daemon location.");
    if (target.kind === "provider") return `${threadBase}/at/${location}/${encodeRouteSegment(target.threadId)}`;
    return `${threadBase}/at/${location}/${encodeRouteSegment(target.parentThreadId)}/sub/${encodeRouteSegment(target.threadId)}`;
  }
  throw new Error("Logical route is missing its required source address.");
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

export function createThreadHref(projectId: string, target: string | WorkbenchThreadRouteTarget) {
  return createWorkbenchHref(createThreadRoute(projectId, target));
}

export function createPinnedThreadHref(projectId: string, threadOwnerProjectId: string, target: string | WorkbenchThreadRouteTarget) {
  return createWorkbenchHref(createPinnedThreadRoute(projectId, threadOwnerProjectId, target));
}

export function createHomeThreadHref(threadOwnerProjectId: string, target: string | WorkbenchThreadRouteTarget) {
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
    && areDeeplyEqual(left.logical, right.logical)
    && areDeeplyEqual(left.threadTarget, right.threadTarget)
    && left.error === right.error;
}

export function routeHasSelection(route: WorkbenchRoute) {
  return route.view === "file" || route.view === "thread" || route.view === "mosaic";
}
