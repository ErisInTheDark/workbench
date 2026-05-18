/*
 * Exports:
 * - WORKBENCH_ROUTE_PREFIX, LEGACY_WORKBENCH_ROUTE_MARKER: route markers for canonical and legacy workbench URLs. Keywords: URL, route, navigation.
 * - WorkbenchRouteView, WorkbenchRoute, WorkbenchRouteParseResult: normalized route contracts. Keywords: URL source of truth, project, file, thread.
 * - createProjectRoute/createFileRoute/createThreadRoute/createInvalidWorkbenchRoute: construct route objects. Keywords: navigation, route builder.
 * - parseWorkbenchRouteFromLocation/parseWorkbenchRouteFromPath: parse browser URL state without mutating history. Keywords: route parser, legacy query, malformed URL.
 * - createWorkbenchHref/createProjectHref/createFileHref/createThreadHref: build canonical hrefs. Keywords: links, URL, encode.
 * - isSameWorkbenchRoute/routeHasSelection: compare and classify routes. Keywords: route equality, active selection.
 */

export const WORKBENCH_ROUTE_PREFIX = "-";
export const LEGACY_WORKBENCH_ROUTE_MARKER = "@";

const LEGACY_FILE_SEARCH_PARAM = "file";
const LEGACY_THREAD_SEARCH_PARAM = "thread";

export type WorkbenchRouteView = "project" | "file" | "thread" | "invalid";

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
  const markerIndex = segments.indexOf(LEGACY_WORKBENCH_ROUTE_MARKER);
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

  if (segments[0] !== WORKBENCH_ROUTE_PREFIX) {
    return parseLegacyRouteFromSegments(segments, searchParams);
  }

  if (segments[1] !== "project") {
    return createInvalidWorkbenchRoute(`Unknown workbench route prefix: ${segments.slice(0, 2).join("/")}`);
  }

  const projectIdSegment = segments[2] ?? "";
  const decodedProjectId = decodeRouteSegment(projectIdSegment);
  if (decodedProjectId.ok === false) {
    return createInvalidWorkbenchRoute(decodedProjectId.error);
  }

  const projectId = decodedProjectId.value;
  const mode = segments[3] ?? "";
  if (!mode) {
    return createProjectRoute(projectId);
  }

  const encodedValue = segments[4] ?? "";
  const decodedValue = decodeRouteSegment(encodedValue);
  if (decodedValue.ok === false) {
    return createInvalidWorkbenchRoute(decodedValue.error, projectId);
  }

  if (segments.length > 5) {
    return createInvalidWorkbenchRoute("Unexpected extra route segments.", projectId);
  }

  if (mode === "file") {
    return createFileRoute(projectId, decodedValue.value);
  }
  if (mode === "thread") {
    return createThreadRoute(projectId, decodedValue.value);
  }

  return createInvalidWorkbenchRoute(`Unknown workbench route mode: ${mode}`, projectId);
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
  const projectSegment = encodeRouteSegment(route.projectId);
  if (route.view === "file") {
    return `/${WORKBENCH_ROUTE_PREFIX}/project/${projectSegment}/file/${encodeRouteSegment(route.filePath)}`;
  }
  if (route.view === "thread") {
    return `/${WORKBENCH_ROUTE_PREFIX}/project/${projectSegment}/thread/${encodeRouteSegment(route.threadId)}`;
  }

  return `/${WORKBENCH_ROUTE_PREFIX}/project/${projectSegment}`;
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
