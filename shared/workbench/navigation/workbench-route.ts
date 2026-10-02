/*
 * Exports:
 * - WORKBENCH_ROUTE_MARKER: route marker for workbench URLs.
 * - WORKBENCH_FOLDER_MARKER: marker segment for the sidebar folder selection slot.
 * - WorkbenchRouteView/WorkbenchRoute/WorkbenchRouteParseResult: normalized route contracts.
 * - createHomeRoute/createProjectSelectionRoute/createToggledProjectSelectionRoute/withProjectSelection/createProjectRoute/createFileRoute/createThreadRoute/createPinnedThreadRoute/createHomeThreadRoute/createSettingsRoute/createStatsRoute/createGitRoute/createMosaicRoute/createInvalidWorkbenchRoute: construct routes.
 * - createLogicalProjectRoute/createLogicalFileRoute/createLogicalGitRoute/createLogicalThreadRoute/createLogicalExistingThreadRoute/createLogicalMosaicRoute: internal project, target and UUID routes.
 * - getWorkbenchThreadTargetRootId/getWorkbenchThreadTargetSelectedId/getWorkbenchMosaicThreadRootIds/isWorkbenchThreadTargetSelected: derive hydration and selection identities.
 * - parseWorkbenchRouteFromLocation/parseWorkbenchRouteFromPath: parse URL state without changing history.
 * - createWorkbenchHref/createHomeHref/createProjectHref/createFileHref/createThreadHref/createPinnedThreadHref/createHomeThreadHref/createSettingsHref/createStatsHref/createMosaicHref: build hrefs.
 * - isSameWorkbenchRoute/isSameDraftRouteIntent/routeHasSelection/isWorkbenchRouteOwnerOfThread: compare and fence route-owned transitions.
 */

import {
  encodeWorkbenchRoutePath,
} from "../../navigation/workbench-route-path.ts";

import { type WorkbenchMosaicNode } from "./workbench-mosaic-route.ts";
import { areDeeplyEqual } from "../deep-equality.ts";
import { z } from "zod";
import { WorkbenchThreadRouteTargetSchema, type WorkbenchThreadRouteTarget } from "../thread/thread-state.ts";
import { DraftIdSchema, LogicalProjectIdSchema, type LogicalProjectId, type ProjectId } from "../identity.ts";
import { ProjectLocationReferenceSchema, type ProjectLocationReference } from "../project/project-location.ts";

export const WORKBENCH_ROUTE_MARKER = "@";
export const WORKBENCH_FOLDER_MARKER = "*";

const LEGACY_FILE_SEARCH_PARAM = "file";
const LEGACY_THREAD_SEARCH_PARAM = "thread";
const RouteThreadReferenceSchema = z.string().brand<"ThreadReference">();
const RouteProjectIdSchema = z.string().brand<"ProjectId">();

export type WorkbenchRouteView = "home" | "project" | "file" | "thread" | "settings" | "stats" | "git" | "mosaic" | "invalid";

export interface WorkbenchRoute {
  error: string;
  filePath: string;
  /** Sidebar folder selection from the `*` url slot. Absent means inherit; null means explicitly no folder. */
  folderAddress?: string[] | null;
  mosaicNode: WorkbenchMosaicNode | null;
  projectId: ProjectId | "";
  selectedProjectIds: readonly string[] | null;
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
    selectedProjectIds: null,
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
    selectedProjectIds: projectId ? [projectId] : [],
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "project",
  };
}

export function createProjectSelectionRoute(selectedProjectIds: readonly string[] | null): WorkbenchRoute {
  if (selectedProjectIds === null) return createHomeRoute();
  const route = createProjectRoute(selectedProjectIds.length === 1 ? selectedProjectIds[0]! : "");
  return { ...route, selectedProjectIds: [...selectedProjectIds] };
}

export function createToggledProjectSelectionRoute(
  route: WorkbenchRoute,
  selectedProjectIds: readonly string[],
  projectId: string,
  orderedProjectIds: readonly string[],
): WorkbenchRoute {
  const next = new Set(selectedProjectIds);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  const nextIds = orderedProjectIds.filter(id => next.has(id));
  const ownerProjectId = route.logical?.threadOwnerProjectId || route.threadOwnerProjectId
    || (!route.logical?.location && route.selectedProjectIds?.length === 1 ? route.selectedProjectIds[0] : "");
  if (route.view === "stats") return withProjectSelection(createStatsRoute(null), nextIds);
  return route.view === "thread" && !(projectId === ownerProjectId && selectedProjectIds.includes(projectId))
    ? withProjectSelection(route, nextIds)
    : createProjectSelectionRoute(nextIds);
}

export function withProjectSelection(route: WorkbenchRoute, selectedProjectIds: readonly string[] | null): WorkbenchRoute {
  return {
    ...route,
    projectId: route.logical ? "" : selectedProjectIds?.length === 1
      ? RouteProjectIdSchema.parse(selectedProjectIds[0]!) : "",
    selectedProjectIds: selectedProjectIds === null ? null : [...selectedProjectIds],
  };
}

export function createLogicalProjectRoute(logicalProjectId: string, location: ProjectLocationReference | null = null): WorkbenchRoute {
  return { ...createProjectRoute(""), selectedProjectIds: [logicalProjectId], logical: {
    projectId: LogicalProjectIdSchema.parse(logicalProjectId),
    threadOwnerProjectId: null,
    location: location ? ProjectLocationReferenceSchema.parse(location) : null,
    browseLocation: null,
  } };
}

export function createLogicalGitRoute(logicalProjectId: string, location: ProjectLocationReference | null): WorkbenchRoute {
  return { ...createLogicalProjectRoute(logicalProjectId, location), view: "git" };
}

export function createLogicalFileRoute(logicalProjectId: string, location: ProjectLocationReference | null, filePath: string): WorkbenchRoute {
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
  return { ...route, selectedProjectIds: selectedLogicalProjectId ? [selectedLogicalProjectId] : null, logical: {
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
  return { ...route, selectedProjectIds: selectedLogicalProjectId ? [selectedLogicalProjectId] : null, logical: {
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
  return { ...createMosaicRoute("", mosaicNode), selectedProjectIds: [logicalProjectId], logical: {
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
    selectedProjectIds: projectId ? [projectId] : null,
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
    selectedProjectIds: projectId ? [projectId] : null,
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
    selectedProjectIds: projectId ? [projectId] : null,
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

export function createSettingsRoute(projectId: string): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    mosaicNode: null,
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
    selectedProjectIds: projectId ? [projectId] : null,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "settings",
  };
}

export function createStatsRoute(projectId: string | null = null): WorkbenchRoute {
  return { ...createProjectRoute(projectId ?? ""), selectedProjectIds: projectId ? [projectId] : null, view: "stats" };
}

export function createMosaicRoute(projectId: string, mosaicNode: WorkbenchMosaicNode): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    mosaicNode,
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
    selectedProjectIds: projectId ? [projectId] : null,
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
    selectedProjectIds: projectId ? [projectId] : null,
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
    if (!mode && segments.length === markerIndex + 1) {
      return projectId ? createProjectRoute(projectId) : createHomeRoute();
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
      return createInvalidWorkbenchRoute("Mosaic routes are unavailable.", projectId);
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
      return valueSegments.value.length
        ? createInvalidWorkbenchRoute(`Unexpected settings route value: ${value}`, projectId)
        : createSettingsRoute(projectId);
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

function parseProjectSelectionRouteFromSegments(segments: string[], searchParams: URLSearchParams): WorkbenchRoute {
  const markerIndex = segments.indexOf(WORKBENCH_ROUTE_MARKER);
  const prefix = markerIndex < 0 ? segments : segments.slice(0, markerIndex);
  const folderMarkerIndex = prefix.indexOf(WORKBENCH_FOLDER_MARKER);
  if (folderMarkerIndex >= 0) {
    const decoded = decodeRouteSegments(prefix.slice(folderMarkerIndex + 1));
    if (decoded.ok === false) return createInvalidWorkbenchRoute(decoded.error);
    if (!decoded.value.length) return createInvalidWorkbenchRoute("Folder selection is empty.");
    const rest = [...prefix.slice(0, folderMarkerIndex), ...(markerIndex < 0 ? [] : segments.slice(markerIndex))];
    const parsed = parseProjectSelectionRouteFromSegments(rest, searchParams);
    return parsed.view === "invalid" ? parsed : { ...parsed, folderAddress: decoded.value };
  }
  if (!prefix.includes("+")) return parseLegacyRouteFromSegments(segments, searchParams);
  const groups: string[][] = [[]];
  for (const segment of prefix) {
    if (segment === "+") groups.push([]);
    else groups.at(-1)!.push(segment);
  }
  const emptySelection = groups.length === 2 && groups.every(group => group.length === 0);
  if (!emptySelection && groups.some(group => group.length === 0)) {
    return createInvalidWorkbenchRoute("Project selection contains an empty project address.");
  }
  const selected: string[] = [];
  for (const group of groups) {
    if (!group.length) continue;
    const decoded = decodeRouteSegments(group);
    if (decoded.ok === false) return createInvalidWorkbenchRoute(decoded.error);
    if (!decoded.value.length) return createInvalidWorkbenchRoute("Project selection contains an empty address.");
    selected.push(decoded.value.join("/"));
  }
  if (new Set(selected).size !== selected.length) {
    return createInvalidWorkbenchRoute("Project selection contains the same project twice.");
  }
  const suffix = markerIndex < 0 ? [] : segments.slice(markerIndex);
  const parsed = parseLegacyRouteFromSegments(suffix.length ? suffix : ["@"], searchParams);
  if (parsed.view === "invalid") return parsed;
  return withProjectSelection(parsed.view === "home" ? { ...parsed, view: "project" } : parsed, selected);
}

export function parseWorkbenchRouteFromPath(pathname: string, search = ""): WorkbenchRouteParseResult {
  return parseWorkbenchRouteSegments(pathname, search);
}

function parseWorkbenchRouteSegments(pathname: string, search: string): WorkbenchRouteParseResult {
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

  return parseProjectSelectionRouteFromSegments(segments, searchParams);
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
  const projectPath = route.selectedProjectIds === null ? ""
    : route.selectedProjectIds.length ? route.selectedProjectIds.map(encodeWorkbenchRoutePath).join("/+/") : "+";
  const folderPath = route.folderAddress?.length
    ? `${WORKBENCH_FOLDER_MARKER}/${route.folderAddress.map(encodeRouteSegment).join("/")}/`
    : "";
  const markedPath = projectPath ? `/${projectPath}/${folderPath}${WORKBENCH_ROUTE_MARKER}` : `/${folderPath}${WORKBENCH_ROUTE_MARKER}`;
  if (route.logical) throw new Error("Logical routes need project-address resolution before serialisation.");
  if (route.view === "home") {
    return "/";
  }
  if (route.view === "file") {
    return `${markedPath}/file/${encodeWorkbenchRoutePath(route.filePath)}`;
  }
  if (route.view === "thread") {
    const target = route.threadTarget ?? (route.threadId === "new" ? { kind: "new" as const } : { kind: "provider" as const, threadId: RouteThreadReferenceSchema.parse(route.threadId) });
    const threadOwnerProjectId = route.threadOwnerProjectId || route.projectId;
    if (!route.projectId && threadOwnerProjectId) {
      const ownerPath = encodeWorkbenchRoutePath(threadOwnerProjectId);
      if (target.kind === "new") return target.folderId
        ? `${markedPath}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/folder/${target.folderId}/thread/new`
        : `${markedPath}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/new`;
      if (target.kind === "draft") return `${markedPath}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/new/${target.draftId}`;
      if (target.kind === "subagent") return `${markedPath}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/${encodeRouteSegment(target.parentThreadId)}/sub/${encodeRouteSegment(target.threadId)}`;
      return `${markedPath}/thread/${ownerPath}/${WORKBENCH_ROUTE_MARKER}/${encodeRouteSegment(target.threadId)}`;
    }
    if (threadOwnerProjectId !== route.projectId) {
      return `${markedPath}/pin${createWorkbenchHref(createThreadRoute(threadOwnerProjectId, target))}`;
    }
    if (target.kind === "new") return target.folderId
      ? `${markedPath}/folder/${target.folderId}/thread/new`
      : `${markedPath}/thread/new`;
    if (target.kind === "draft") return `${markedPath}/thread/new/${target.draftId}`;
    if (target.kind === "subagent") return `${markedPath}/thread/${encodeRouteSegment(target.parentThreadId)}/sub/${encodeRouteSegment(target.threadId)}`;
    return `${markedPath}/thread/${encodeRouteSegment(target.threadId)}`;
  }
  if (route.view === "settings") return `${markedPath}/settings`;
  if (route.view === "git") return `${markedPath}/git`;
  if (route.view === "stats") {
    return `${markedPath}/stats`;
  }
  if (route.view === "mosaic") throw new Error("Mosaic routes are unavailable.");

  return `${markedPath}/`;
}

export function createProjectHref(projectId: string) {
  return createWorkbenchHref(createProjectRoute(projectId));
}

export function createHomeHref() {
  return "/";
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

export function createSettingsHref(projectId: string) {
  return createWorkbenchHref(createSettingsRoute(projectId));
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
    && areDeeplyEqual(left.selectedProjectIds, right.selectedProjectIds)
    && areDeeplyEqual(left.folderAddress ?? null, right.folderAddress ?? null)
    && left.filePath === right.filePath
    && areDeeplyEqual(left.mosaicNode, right.mosaicNode)
    && left.threadId === right.threadId
    && left.threadOwnerProjectId === right.threadOwnerProjectId
    && areDeeplyEqual(left.logical, right.logical)
    && areDeeplyEqual(left.threadTarget, right.threadTarget)
    && left.error === right.error;
}

export function isSameDraftRouteIntent(before: WorkbenchRoute, current: WorkbenchRoute, draftId: string) {
  if (before === current) return true;
  if (before.view !== "thread" || before.threadTarget?.kind !== "new" || !before.logical) return false;
  return isSameWorkbenchRoute({
    ...before,
    threadId: draftId,
    threadTarget: { kind: "draft", draftId: DraftIdSchema.parse(draftId) },
    logical: { ...before.logical, location: null },
  }, current);
}

export function routeHasSelection(route: WorkbenchRoute) {
  return route.view === "file" || route.view === "thread" || route.view === "mosaic";
}
