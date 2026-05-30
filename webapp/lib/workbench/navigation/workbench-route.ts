/*
 * Exports:
 * - WORKBENCH_ROUTE_MARKER: route marker for canonical workbench URLs. Keywords: URL, route, navigation.
 * - WorkbenchRouteView, WorkbenchRoute, WorkbenchRouteParseResult: normalized route contracts. Keywords: URL source of truth, project, file, thread, settings.
 * - createProjectRoute/createFileRoute/createThreadRoute/createSettingsRoute/createInvalidWorkbenchRoute: construct route objects. Keywords: navigation, route builder.
 * - parseWorkbenchRouteFromLocation/parseWorkbenchRouteFromPath: parse browser URL state without mutating history. Keywords: route parser, legacy query, malformed URL.
 * - createWorkbenchHref/createProjectHref/createFileHref/createThreadHref/createSettingsHref: build canonical hrefs. Keywords: links, URL, encode.
 * - isSameWorkbenchRoute/routeHasSelection: compare and classify routes. Keywords: route equality, active selection.
 */

export const WORKBENCH_ROUTE_MARKER = "@";

const LEGACY_FILE_SEARCH_PARAM = "file";
const LEGACY_THREAD_SEARCH_PARAM = "thread";

export type WorkbenchRouteView = "project" | "file" | "thread" | "settings" | "invalid";

export interface WorkbenchRoute {
  error: string;
  filePath: string;
  projectId: string;
  threadId: string;
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
    projectId,
    threadId: "",
    view: "project",
  };
}

export function createFileRoute(projectId: string, filePath: string): WorkbenchRoute {
  return {
    error: "",
    filePath,
    projectId,
    threadId: "",
    view: "file",
  };
}

export function createThreadRoute(projectId: string, threadId: string): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    projectId,
    threadId,
    view: "thread",
  };
}

export function createSettingsRoute(projectId: string): WorkbenchRoute {
  return {
    error: "",
    filePath: "",
    projectId,
    threadId: "",
    view: "settings",
  };
}

export function createInvalidWorkbenchRoute(error: string, projectId = ""): WorkbenchRoute {
  return {
    error,
    filePath: "",
    projectId,
    threadId: "",
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
    const valueSegments = decodeRouteSegments(segments.slice(markerIndex + 2));
    if (valueSegments.ok === false) {
      return createInvalidWorkbenchRoute(valueSegments.error, projectSegments.value.join("/"));
    }

    const projectId = projectSegments.value.join("/");
    const value = valueSegments.value.join("/");
    if (mode === "file") {
      return createFileRoute(projectId, value);
    }
    if (mode === "thread") {
      return createThreadRoute(projectId, value);
    }
    if (mode === "settings") {
      return createSettingsRoute(projectId);
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
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/${encodeRoutePath(route.threadId)}`;
  }
  if (route.view === "settings") {
    return `/${projectPath}/${WORKBENCH_ROUTE_MARKER}/settings`;
  }

  return projectPath ? `/${projectPath}` : "/";
}

export function createProjectHref(projectId: string) {
  return createWorkbenchHref(createProjectRoute(projectId));
}

export function createFileHref(projectId: string, filePath: string) {
  return createWorkbenchHref(createFileRoute(projectId, filePath));
}

export function createThreadHref(projectId: string, threadId: string) {
  return createWorkbenchHref(createThreadRoute(projectId, threadId));
}

export function createSettingsHref(projectId: string) {
  return createWorkbenchHref(createSettingsRoute(projectId));
}

export function isSameWorkbenchRoute(left: WorkbenchRoute, right: WorkbenchRoute) {
  return left.view === right.view
    && left.projectId === right.projectId
    && left.filePath === right.filePath
    && left.threadId === right.threadId
    && left.error === right.error;
}

export function routeHasSelection(route: WorkbenchRoute) {
  return route.view === "file" || route.view === "thread";
}
