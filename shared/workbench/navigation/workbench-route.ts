/*
 * Exports:
 * - WORKBENCH_ROUTE_MARKER: route marker for workbench URLs.
 * - WORKBENCH_FOLDER_MARKER: marker segment for the sidebar folder selection slot.
 * - LEGACY_TAB_SEARCH_PARAMS: query names of the old tab strip, read once and then dropped.
 * - WorkbenchRouteView/WorkbenchRoute/WorkbenchRouteParseResult: normalized route contracts.
 * - WorkbenchFileTab/withFileTabs/getWorkbenchFileTabs: a file route's own folder address (old urls could list several file tabs).
 * - withFileDestination: the same file tab showing another entry of its folder, or that folder's index.
 * - formatWorkbenchTab: one destination as its tab after the route marker (thread, file with its folder, settings, ...).
 * - createSettledThreadExitRoute: leave a settled viewed thread while keeping the project selection.
 * - createDiscardedDraftExitRoute: leave only the draft still viewed when deletion completes.
 * - WORKBENCH_STATS_TABS/WorkbenchStatsTab: stats view tabs carried in the url.
 * - createHomeRoute/createProjectSelectionRoute/createToggledProjectSelectionRoute/withProjectSelection/createProjectRoute/createFileRoute/createThreadRoute/createPinnedThreadRoute/createHomeThreadRoute/createSettingsRoute/createNewProjectRoute/createStatsRoute/createGitRoute/createInvalidWorkbenchRoute: construct routes.
 * - createLogicalProjectRoute/createLogicalFileRoute/createLogicalGitRoute/createLogicalThreadRoute/createLogicalExistingThreadRoute: internal project, target and UUID routes.
 * - getWorkbenchThreadTargetRootId/getWorkbenchThreadTargetSelectedId/isWorkbenchThreadTargetSelected: derive hydration and selection identities.
 * - parseWorkbenchRouteFromLocation/parseWorkbenchRouteFromPath: parse URL state without changing history.
 * - salvageWorkbenchPath: the nearest valid path to a broken one, keeping its valid tabs, selection and folder.
 * - createWorkbenchHref/createHomeHref/createProjectHref/createFileHref/createThreadHref/createPinnedThreadHref/createHomeThreadHref/createSettingsHref/createStatsHref: build hrefs.
 * - isSameWorkbenchRoute/isSameDraftRouteIntent/routeHasSelection/isWorkbenchRouteOwnerOfThread: compare and fence route-owned transitions.
 */

import {
  encodeWorkbenchRoutePath,
} from "../../navigation/workbench-route-path.ts";

import { WorkbenchTabStrip } from "./workbench-tabs.ts";
import { areDeeplyEqual } from "../deep-equality.ts";
import { z } from "zod";
import { WorkbenchThreadRouteTargetSchema, type WorkbenchThreadRouteTarget } from "../thread/thread-state.ts";
import { DraftIdSchema, LogicalProjectIdSchema, type LogicalProjectId, type ProjectId } from "../identity.ts";
import { ProjectLocationReferenceSchema, type ProjectLocationReference } from "../project/project-location.ts";

export const WORKBENCH_ROUTE_MARKER = "@";
export const WORKBENCH_FOLDER_MARKER = "*";

const LEGACY_FILE_SEARCH_PARAM = "file";
/** Tabs briefly rode the query (`?tab=...&tab=...&preview=<index>`) before the tab list moved into the path. */
export const LEGACY_TAB_SEARCH_PARAMS = { tab: "tab", preview: "preview" } as const;
const LEGACY_THREAD_SEARCH_PARAM = "thread";
const RouteThreadReferenceSchema = z.string().brand<"ThreadReference">();
const RouteProjectIdSchema = z.string().brand<"ProjectId">();

export type WorkbenchRouteView = "home" | "project" | "file" | "thread" | "settings" | "stats" | "git" | "new-project" | "invalid";

export const WORKBENCH_STATS_TABS = ["usage", "workspaces", "tools"] as const;
export type WorkbenchStatsTab = typeof WORKBENCH_STATS_TABS[number];

/** One open file tab; a null folder address means the route's own sidebar folder. */
export interface WorkbenchFileTab {
  filePath: string;
  folderAddress: readonly string[] | null;
}

export interface WorkbenchRoute {
  error: string;
  /** Focused file; with `fileTabs` it is always `fileTabs[fileTabIndex].filePath`. */
  filePath: string;
  /** Open file tabs in order; absent means the single `filePath` tab in the route folder. */
  fileTabs?: readonly WorkbenchFileTab[];
  fileTabIndex?: number;
  /** The tab shows the index of `filePath`'s folder, focused on that entry, instead of the file itself. */
  fileIndex?: boolean;
  /** Sidebar folder selection from the `*` url slot. Absent means inherit; null means explicitly no folder. */
  folderAddress?: string[] | null;
  projectId: ProjectId | "";
  selectedProjectIds: readonly string[] | null;
  /** Stats view tab; absent means usage. */
  statsTab?: WorkbenchStatsTab;
  /** Open tabs as written after the route marker; this route's own tab is the active one. Absent means just this tab. */
  tabStrip?: WorkbenchTabStrip;
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
  if (route.view === "stats") return withProjectSelection(createStatsRoute(null, route.statsTab), nextIds);
  return route.view === "thread" && !(projectId === ownerProjectId && selectedProjectIds.includes(projectId))
    ? withProjectSelection(route, nextIds)
    : createProjectSelectionRoute(nextIds);
}

export function createDiscardedDraftExitRoute(route: WorkbenchRoute, draftId: string): WorkbenchRoute | null {
  if (route.view !== "thread" || route.threadTarget?.kind !== "draft" || route.threadTarget.draftId !== draftId) return null;
  const exit = createSettledThreadExitRoute(route, route.threadOwnerProjectId);
  return { ...exit, folderAddress: route.folderAddress };
}

/** Leave a settled thread for the view that listed it, keeping the project selection. */
export function createSettledThreadExitRoute(route: WorkbenchRoute, ownerProjectId: string): WorkbenchRoute {
  const selection = route.selectedProjectIds;
  if (route.logical) {
    const projectId = route.logical.projectId;
    if (projectId && (selection === null || (selection.length === 1 && selection[0] === projectId))) {
      return createLogicalProjectRoute(projectId, route.logical.browseLocation ?? null);
    }
    const selectionRoute = createProjectSelectionRoute(selection);
    return route.folderAddress === undefined ? selectionRoute : {
      ...selectionRoute,
      folderAddress: route.folderAddress && [...route.folderAddress],
    };
  }
  const targetProjectId = ownerProjectId || route.threadOwnerProjectId || route.projectId;
  return withProjectSelection(!route.projectId
    ? createHomeThreadRoute(targetProjectId, { kind: "new" })
    : createThreadRoute(route.projectId, { kind: "new" }), selection);
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

export function createGitRoute(projectId: string): WorkbenchRoute {
  return { ...createProjectRoute(projectId), view: "git" };
}

export function createFileRoute(projectId: string, filePath: string): WorkbenchRoute {
  return {
    error: "",
    filePath,
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
    selectedProjectIds: projectId ? [projectId] : null,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "file",
  };
}

/**
 * The same tab showing another entry of its folder: a file, or with `index` the folder index focused on `filePath`.
 * The tab keeps its own folder address.
 */
export function withFileDestination(route: WorkbenchRoute, filePath: string, index = false): WorkbenchRoute {
  const { tabs, index: at } = getWorkbenchFileTabs(route);
  const { fileIndex: _index, ...base } = route;
  const destination: WorkbenchRoute = { ...base, view: "file", filePath, ...(index ? { fileIndex: true } : {}) };
  return withFileTabs(destination, [{ filePath, folderAddress: tabs[at]?.folderAddress ?? null }], 0);
}

/** Focus `index` among `tabs`; a lone tab in the route folder collapses back to a plain file route. */
export function withFileTabs(route: WorkbenchRoute, tabs: readonly WorkbenchFileTab[], index: number): WorkbenchRoute {
  const focused = tabs[index];
  if (!focused) throw new Error("The focused file tab must exist.");
  const { fileTabs: _tabs, fileTabIndex: _index, ...base } = route;
  return tabs.length === 1 && !focused.folderAddress
    ? { ...base, view: "file", filePath: focused.filePath }
    : { ...base, view: "file", filePath: focused.filePath, fileTabs: tabs.map(tab => ({ ...tab })), fileTabIndex: index };
}

export function getWorkbenchFileTabs(route: WorkbenchRoute): { tabs: readonly WorkbenchFileTab[]; index: number } {
  if (route.view !== "file") return { tabs: [], index: -1 };
  return route.fileTabs?.length
    ? { tabs: route.fileTabs, index: route.fileTabIndex ?? 0 }
    : { tabs: route.filePath ? [{ filePath: route.filePath, folderAddress: null }] : [], index: 0 };
}

function parseFileRoute(projectId: string, segments: readonly string[]): WorkbenchRoute {
  if (!segments.includes("+") && !segments.includes(WORKBENCH_FOLDER_MARKER)) return createFileRoute(projectId, segments.join("/"));
  const [indexText = "", ...rest] = segments;
  const index = Number(indexText);
  const groups: string[][] = [[]];
  for (const segment of rest) {
    if (segment === "+") groups.push([]);
    else groups.at(-1)!.push(segment);
  }
  const tabs: WorkbenchFileTab[] = [];
  for (const group of groups) {
    const marker = group.indexOf(WORKBENCH_FOLDER_MARKER);
    const folderAddress = marker < 0 ? null : group.slice(0, marker);
    const filePath = group.slice(marker + 1).join("/");
    if (!filePath || folderAddress?.length === 0) return createInvalidWorkbenchRoute("File tabs need a path and, when marked, a folder.", projectId);
    tabs.push({ filePath, folderAddress });
  }
  if (!Number.isInteger(index) || index < 1 || index > tabs.length) {
    return createInvalidWorkbenchRoute("File tab routes start with the focused tab number.", projectId);
  }
  return withFileTabs(createFileRoute(projectId, tabs[index - 1]!.filePath), tabs, index - 1);
}

export function createThreadRoute(projectId: string, target: string | WorkbenchThreadRouteTarget): WorkbenchRoute {
  const threadTarget: WorkbenchThreadRouteTarget = typeof target === "string"
    ? target === "new" ? { kind: "new" } : { kind: "provider", threadId: RouteThreadReferenceSchema.parse(target) }
    : WorkbenchThreadRouteTargetSchema.parse(target);
  return {
    error: "",
    filePath: "",
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
    projectId: projectId ? RouteProjectIdSchema.parse(projectId) : "",
    selectedProjectIds: projectId ? [projectId] : null,
    threadId: "",
    threadOwnerProjectId: "",
    threadTarget: null,
    view: "settings",
  };
}

export function createNewProjectRoute(): WorkbenchRoute {
  return { ...createSettingsRoute(""), view: "new-project" };
}

export function createStatsRoute(projectId: string | null = null, tab: WorkbenchStatsTab = "usage"): WorkbenchRoute {
  return {
    ...createProjectRoute(projectId ?? ""), selectedProjectIds: projectId ? [projectId] : null, view: "stats",
    ...(tab === "usage" ? {} : { statsTab: tab }),
  };
}

export function createInvalidWorkbenchRoute(error: string, projectId = ""): WorkbenchRoute {
  return {
    error,
    filePath: "",
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

/** A tab's flags segment: `*` active, `~` replaceable, or both in either order. */
function isTabFlags(segment: string | undefined) {
  return Boolean(segment) && /^[*~]{1,2}$/u.test(segment!) && new Set(segment).size === segment!.length;
}

/** One tab's destination with no project selection; the caller applies the url's selection prefix. */
function parseTabSegments(rawSegments: string[]): WorkbenchRoute {
  const decoded = decodeRouteSegments(rawSegments);
  if (decoded.ok === false) return createInvalidWorkbenchRoute(decoded.error);
  const [mode, ...rest] = decoded.value;
  if (mode === "thread") {
    const [owner, ...target] = rest;
    if (!owner) return createInvalidWorkbenchRoute("Thread tabs name their owning project.");
    const parsed = target[0] === "folder" && target.length === 3 && target[2] === "new"
      ? WorkbenchThreadRouteTargetSchema.safeParse({ folderId: target[1], kind: "new" })
      : target[0] === "new" && target.length <= 2
        ? WorkbenchThreadRouteTargetSchema.safeParse(target.length === 1 ? { kind: "new" } : { draftId: target[1], kind: "draft" })
        : target.length === 3 && target[1] === "sub"
          ? WorkbenchThreadRouteTargetSchema.safeParse({ kind: "subagent", parentThreadId: target[0], threadId: target[2] })
          : target.length === 1
            ? WorkbenchThreadRouteTargetSchema.safeParse({ kind: "provider", threadId: target[0] })
            : null;
    return parsed?.success ? createHomeThreadRoute(owner, parsed.data) : createInvalidWorkbenchRoute("Invalid thread tab.");
  }
  if (mode === "file" || mode === "index") {
    const fileSegments = rawSegments.slice(1);
    const marker = fileSegments.indexOf(WORKBENCH_FOLDER_MARKER);
    const folder = marker < 0 ? { ok: true as const, value: null } : decodeRouteSegments(fileSegments.slice(0, marker));
    const path = decodeRouteSegments(fileSegments.slice(marker + 1));
    if (folder.ok === false) return createInvalidWorkbenchRoute(folder.error);
    if (path.ok === false) return createInvalidWorkbenchRoute(path.error);
    const filePath = path.value.join("/");
    if (!filePath || folder.value?.length === 0) return createInvalidWorkbenchRoute("File tabs need a path and, when marked, a folder.");
    const route = { ...createFileRoute("", filePath), ...(mode === "index" ? { fileIndex: true } : {}) };
    return folder.value ? withFileTabs(route, [{ filePath, folderAddress: folder.value }], 0) : route;
  }
  if (mode === "settings" && !rest.length) return createSettingsRoute("");
  if (mode === "new-project" && !rest.length) return createNewProjectRoute();
  if (mode === "git" && !rest.length) return { ...createGitRoute(""), selectedProjectIds: null };
  if (mode === "stats" && rest.length <= 1) {
    const tab = rest.length ? WORKBENCH_STATS_TABS.find(candidate => candidate === rest[0]) : "usage";
    if (tab) return createStatsRoute(null, tab);
  }
  return createInvalidWorkbenchRoute(`Unknown workbench tab: ${decoded.value.join("/")}`);
}

/**
 * The nearest path to a broken one that `isValid` accepts: its valid tabs (an unflagged list reads as one active tab,
 * and the first survivor takes over a dropped active tab), then its project selection and folder alone, then its
 * selection without the folder, then home.
 */
export function salvageWorkbenchPath(pathname: string, isValid: (path: string) => boolean): string {
  const segments = pathname.split("/").filter(Boolean);
  const marker = segments.indexOf(WORKBENCH_ROUTE_MARKER);
  const prefix = marker < 0 ? segments : segments.slice(0, marker);
  const groups: string[][] = [[]];
  for (const segment of marker < 0 ? [] : segments.slice(marker + 1)) {
    if (segment === "+") groups.push([]);
    else groups.at(-1)!.push(segment);
  }
  const flagged = groups.some(group => isTabFlags(group[0]));
  const tabGroups = flagged ? groups : [groups.flat()];
  const tabs = tabGroups.flatMap(group => {
    const flags = isTabFlags(group[0]) ? group[0]! : "";
    const tail = flags ? group.slice(1) : group;
    return tail.length && isValid(`/${WORKBENCH_ROUTE_MARKER}/*/${tail.join("/")}`)
      ? [{ active: !flagged || flags.includes("*"), tail }] : [];
  });
  const active = Math.max(0, tabs.findIndex(tab => tab.active));
  const tabPath = tabs.map((tab, index) => [...(index === active ? ["*"] : []), ...tab.tail].join("/")).join("/+/");
  const folder = prefix.indexOf(WORKBENCH_FOLDER_MARKER);
  const selections = folder < 0 ? [prefix] : [prefix, prefix.slice(0, folder)];
  const candidates = selections.flatMap(selection => {
    const head = selection.length ? `/${selection.join("/")}` : "";
    return [...(tabs.length ? [`${head}/${WORKBENCH_ROUTE_MARKER}/${tabPath}`] : []), `${head}/${WORKBENCH_ROUTE_MARKER}/`];
  });
  return candidates.find(isValid) ?? "/";
}

/** The flagged tab list after the route marker, or null for an older route shape. */
function parseTabList(afterMarker: string[], projectId: string): WorkbenchRoute | null {
  const groups: string[][] = [[]];
  for (const segment of afterMarker) {
    if (segment === "+") groups.push([]);
    else groups.at(-1)!.push(segment);
  }
  if (!groups.some(group => isTabFlags(group[0]))) return null;
  const tabs: string[] = [];
  let active = -1;
  let preview: number | null = null;
  for (const [index, group] of groups.entries()) {
    const flags = isTabFlags(group[0]) ? group[0]! : "";
    const tail = flags ? group.slice(1) : group;
    if (!tail.length) return createInvalidWorkbenchRoute("A tab is empty.", projectId);
    if (flags.includes("*")) {
      if (active >= 0) return createInvalidWorkbenchRoute("Only one tab can be active.", projectId);
      active = index;
    }
    if (flags.includes("~")) preview = index;
    tabs.push(tail.join("/"));
  }
  if (active < 0) return createInvalidWorkbenchRoute("One tab must be active.", projectId);
  const route = parseTabSegments(groups[active]!.slice(isTabFlags(groups[active]![0]) ? 1 : 0));
  if (route.view === "invalid") return route;
  const selected = projectId ? withProjectSelection(route, [projectId]) : route;
  // A lone durable tab is what every route already means, so it carries no strip.
  return tabs.length === 1 && preview === null ? selected : { ...selected, tabStrip: { tabs, preview } };
}

/** Old urls listed several svg tabs inside one file route; they become ordinary tabs. */
function withLegacyFileTabs(route: WorkbenchRoute): WorkbenchRoute {
  if (route.view !== "file" || (route.fileTabs?.length ?? 0) < 2) return route;
  const { tabs, index } = getWorkbenchFileTabs(route);
  const tabStrip = {
    tabs: tabs.map(tab => formatWorkbenchTab(withFileTabs(createFileRoute("", tab.filePath), [tab], 0))!),
    preview: null,
  };
  return { ...withFileTabs(route, [tabs[index]!], 0), tabStrip };
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
    const tabList = parseTabList(segments.slice(markerIndex + 1), projectId);
    if (tabList) return tabList;
    if (!mode && segments.length === markerIndex + 1) {
      return projectId ? createProjectRoute(projectId) : createHomeRoute();
    }
    const ownerMarkerIndex = segments.indexOf(WORKBENCH_ROUTE_MARKER, markerIndex + 2);
    if (projectId && mode === "thread" && ownerMarkerIndex >= 0) {
      const homeThread = parseLegacyRouteFromSegments(segments.slice(markerIndex), searchParams);
      return homeThread.view === "invalid" ? homeThread : withProjectSelection(homeThread, [projectId]);
    }
    if (!projectId && mode === "thread") {
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

    const valueSegments = decodeRouteSegments(segments.slice(markerIndex + 2));
    if (valueSegments.ok === false) {
      return createInvalidWorkbenchRoute(valueSegments.error, projectId);
    }

    const value = valueSegments.value.join("/");
    if (mode === "file") {
      return withLegacyFileTabs(parseFileRoute(projectId, valueSegments.value));
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
      return !valueSegments.value.length
        ? withProjectSelection(createGitRoute(projectId), projectId ? [projectId] : null)
        : createInvalidWorkbenchRoute("Git routes do not accept extra segments.", projectId);
    }
    if (mode === "stats") {
      const tab = WORKBENCH_STATS_TABS.find((candidate) => candidate === value);
      return !valueSegments.value.length ? createStatsRoute(projectId)
        : tab && valueSegments.value.length === 1 ? createStatsRoute(projectId, tab)
          : createInvalidWorkbenchRoute(`Unexpected stats route value: ${value}`, projectId);
    }
    if (mode === "new-project") {
      return valueSegments.value.length
        ? createInvalidWorkbenchRoute(`Unexpected new project route value: ${value}`, projectId)
        : withProjectSelection(createNewProjectRoute(), projectId ? [projectId] : null);
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

  return withLegacyTabQuery(parseProjectSelectionRouteFromSegments(segments, searchParams), searchParams);
}

function withLegacyTabQuery(route: WorkbenchRoute, searchParams: URLSearchParams): WorkbenchRoute {
  const legacyTabs = searchParams.getAll(LEGACY_TAB_SEARCH_PARAMS.tab).filter(Boolean);
  if (route.view === "invalid" || route.tabStrip || !legacyTabs.length) return route;
  const tabs: string[] = [];
  const hasPreview = searchParams.has(LEGACY_TAB_SEARCH_PARAMS.preview);
  const legacyPreview = Number(searchParams.get(LEGACY_TAB_SEARCH_PARAMS.preview));
  let preview: number | null = null;
  for (const [index, legacyTab] of legacyTabs.entries()) {
    const tab = formatWorkbenchTab(parseWorkbenchRouteSegments(`/${WORKBENCH_ROUTE_MARKER}/${legacyTab}`, ""));
    if (!tab || tabs.includes(tab)) continue;
    if (hasPreview && legacyPreview === index) preview = tabs.length;
    tabs.push(tab);
  }
  return tabs.length ? { ...route, tabStrip: { tabs, preview } } : route;
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
  if (route.view === "home") return "/";
  const active = formatWorkbenchTab(route);
  if (!active) return `${markedPath}/`;
  const strip = route.tabStrip ? WorkbenchTabStrip.open(route.tabStrip, active) : { tabs: [active], preview: null };
  const tabs = strip.tabs.map((tab, index) => {
    const flags = `${tab === active ? "*" : ""}${index === strip.preview ? "~" : ""}`;
    return flags ? `${flags}/${tab}` : tab;
  });
  return `${markedPath}/${tabs.join("/+/")}`;
}

export function formatWorkbenchTab(route: WorkbenchRoute): string | undefined {
  if (route.view === "thread") {
    const owner = route.threadOwnerProjectId || route.projectId;
    const target = route.threadTarget ?? (route.threadId === "new" ? { kind: "new" as const } : { kind: "provider" as const, threadId: RouteThreadReferenceSchema.parse(route.threadId) });
    if (!owner) return undefined;
    const ownerTab = `thread/${encodeRouteSegment(owner)}`;
    if (target.kind === "new") return target.folderId ? `${ownerTab}/folder/${encodeRouteSegment(target.folderId)}/new` : `${ownerTab}/new`;
    if (target.kind === "draft") return `${ownerTab}/new/${encodeRouteSegment(target.draftId)}`;
    if (target.kind === "subagent") return `${ownerTab}/${encodeRouteSegment(target.parentThreadId)}/sub/${encodeRouteSegment(target.threadId)}`;
    return `${ownerTab}/${encodeRouteSegment(target.threadId)}`;
  }
  if (route.view === "file") {
    if (!route.filePath) return undefined;
    const { tabs, index } = getWorkbenchFileTabs(route);
    const folder = tabs[index]?.folderAddress;
    return `${route.fileIndex ? "index" : "file"}/${folder?.length ? `${folder.map(encodeRouteSegment).join("/")}/${WORKBENCH_FOLDER_MARKER}/` : ""}${encodeWorkbenchRoutePath(route.filePath)}`;
  }
  if (route.view === "settings" || route.view === "new-project" || route.view === "git") return route.view;
  if (route.view === "stats") return route.statsTab && route.statsTab !== "usage" ? `stats/${route.statsTab}` : "stats";
  return undefined;
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

export function isSameWorkbenchRoute(left: WorkbenchRoute, right: WorkbenchRoute) {
  return left.view === right.view
    && left.projectId === right.projectId
    && areDeeplyEqual(left.selectedProjectIds, right.selectedProjectIds)
    && areDeeplyEqual(left.folderAddress ?? null, right.folderAddress ?? null)
    && left.filePath === right.filePath
    && Boolean(left.fileIndex) === Boolean(right.fileIndex)
    && areDeeplyEqual(left.fileTabs ?? null, right.fileTabs ?? null)
    && (left.fileTabIndex ?? 0) === (right.fileTabIndex ?? 0)
    && left.threadId === right.threadId
    && (left.statsTab ?? "usage") === (right.statsTab ?? "usage")
    && left.threadOwnerProjectId === right.threadOwnerProjectId
    && areDeeplyEqual(left.logical, right.logical)
    && areDeeplyEqual(left.threadTarget, right.threadTarget)
    && left.error === right.error;
}

export function isSameDraftRouteIntent(before: WorkbenchRoute, current: WorkbenchRoute, draftId: string) {
  if (before === current) return true;
  if (before.view !== "thread") return false;
  if (before.threadTarget?.kind === "draft") {
    return before.threadTarget.draftId === draftId && isSameWorkbenchRoute(before, current);
  }
  if (before.threadTarget?.kind !== "new" || !before.logical) return false;
  return isSameWorkbenchRoute({
    ...before,
    threadId: draftId,
    threadTarget: { kind: "draft", draftId: DraftIdSchema.parse(draftId) },
    logical: { ...before.logical, location: null },
  }, current);
}

export function routeHasSelection(route: WorkbenchRoute) {
  return route.view === "file" || route.view === "thread";
}
