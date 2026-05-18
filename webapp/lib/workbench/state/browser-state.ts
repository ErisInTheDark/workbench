/**
 * Exports:
 * - DEFAULT_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE: editor font size defaults and bounds. Keywords: editor zoom, font size, clamp.
 * - WORKBENCH_ROUTE_MARKER, CURRENT_FILE_SEARCH_PARAM, CURRENT_THREAD_SEARCH_PARAM: URL markers and legacy search param names for current workbench selection. Keywords: URL state, file, thread, project.
 * - CURRENT_SELECTION_URL_UPDATED_EVENT: browser event fired after the workbench updates project/file/thread selection in the URL. Keywords: URL state, selection event, history.
 * - EXPANDED_DIRECTORIES_STORAGE_KEY, FONT_SIZE_STORAGE_KEY, HARNESS_STORAGE_KEY, HARNESS_MODEL_STORAGE_KEY, HARNESS_MODEL_EFFORT_STORAGE_KEY, HARNESS_AGENT_STORAGE_KEY, THREAD_UNREAD_STATE_STORAGE_KEY, THREAD_LIVE_ACTIVITY_OPEN_STORAGE_KEY: localStorage keys for persisted explorer, editor, harness, model, effort, agent, thread unread state, and live activity disclosure state. Keywords: localStorage, explorer, font size, harness, model, effort, agent, threads, live activity.
 * - WorkbenchSelectionSearchParams: normalized project/file/thread URL selection shape. Keywords: URL state, search params, file, thread.
 * - readStoredExpandedDirectories: read and normalize persisted expanded directory paths for a project. Keywords: localStorage, explorer tree, expanded directories, browser state.
 * - persistExpandedDirectories: persist expanded directory paths for a project from a provided collection. Keywords: localStorage, explorer tree, persistence, directories.
 * - readStoredFontSize: read and clamp the persisted editor font size. Keywords: localStorage, editor zoom, font size, clamp.
 * - persistFontSize: persist a provided editor font size value. Keywords: localStorage, editor zoom, persistence.
 * - readStoredHarness/persistHarness: persist the selected bridge harness. Keywords: localStorage, codex, copilot, harness.
 * - readStoredHarnessModel/persistHarnessModel: persist the preferred model for each harness. Keywords: localStorage, codex, copilot, harness, model.
 * - readStoredHarnessModelEffort/persistHarnessModelEffort: persist the preferred reasoning effort for each harness/model pair. Keywords: localStorage, codex, copilot, harness, model, effort.
 * - readStoredHarnessAgent/persistHarnessAgent: persist the preferred agent file for each harness. Keywords: localStorage, codex, copilot, harness, agent.
 * - readStoredThreadUnreadState/persistThreadUnreadState: persist per-thread unread tracking for sidebar badges. Keywords: localStorage, threads, unread, badges.
 * - readStoredThreadLiveActivityOpen/persistThreadLiveActivityOpen: persist the shared thread live activity disclosure state. Keywords: localStorage, thread, reasoning, subagent, disclosure.
 * - readLocalWorkbenchOrigin: read the local loopback workbench origin for agent bootstrap URLs. Keywords: localhost, loopback, URL, workbench, bootstrap.
 * - readCurrentSelectionFromUrl: read the normalized file/thread selection from the current URL. Keywords: URL state, search params, file selection, thread selection.
 * - getRequestedPathFromUrl/getRequestedProjectIdFromUrl: read the requested project/file path from the current URL. Keywords: URL state, route params, file selection, project.
 * - getRequestedThreadIdFromUrl: read the requested thread id from the current URL. Keywords: URL state, search params, thread selection.
 * - syncCurrentSelectionToUrl: update the current file and thread URL search params without navigation. Keywords: history.replaceState, URL sync, selection state, file, thread.
 */

import type { WorkbenchHarness, WorkbenchStoredThreadUnreadState } from "../../types";

export const DEFAULT_EDITOR_FONT_SIZE = 1.08;
export const MIN_EDITOR_FONT_SIZE = 0.84;
export const MAX_EDITOR_FONT_SIZE = 1.72;
export const CURRENT_FILE_SEARCH_PARAM = "file";
export const CURRENT_THREAD_SEARCH_PARAM = "thread";
export const WORKBENCH_ROUTE_MARKER = "@";
export const CURRENT_SELECTION_URL_UPDATED_EVENT = "workbench:selection-url-updated";
export const EXPANDED_DIRECTORIES_STORAGE_KEY = "workbench:expanded-directories";
export const FONT_SIZE_STORAGE_KEY = "workbench:font-size";
export const HARNESS_STORAGE_KEY = "workbench:harness";
export const HARNESS_MODEL_STORAGE_KEY = "workbench:harness-models";
export const HARNESS_MODEL_EFFORT_STORAGE_KEY = "workbench:harness-model-efforts";
export const HARNESS_AGENT_STORAGE_KEY = "workbench:harness-agents";
export const THREAD_UNREAD_STATE_STORAGE_KEY = "workbench:thread-unread-state";
export const THREAD_LIVE_ACTIVITY_OPEN_STORAGE_KEY = "workbench:thread-live-activity-open";

export interface WorkbenchSelectionSearchParams {
  projectId: string;
  filePath: string;
  threadId: string;
}

function emptySelection(): WorkbenchSelectionSearchParams {
  return {
    filePath: "",
    projectId: "",
    threadId: "",
  };
}

function encodeWorkbenchRoutePath(path: string) {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeWorkbenchRouteSegments(segments: string[]) {
  return segments
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter((segment) => segment.length > 0)
    .join("/");
}

function normalizeStoredThreadUnreadState(value: unknown): WorkbenchStoredThreadUnreadState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<WorkbenchStoredThreadUnreadState>;
  if (
    typeof candidate.lastObservedStatus !== "string"
    || !Number.isFinite(candidate.lastObservedUpdatedAt)
    || !Number.isFinite(candidate.lastSeenItemCount)
    || !Number.isFinite(candidate.totalItemCount)
  ) {
    return null;
  }

  const totalItemCount = Math.max(0, Math.trunc(candidate.totalItemCount));
  return {
    lastObservedStatus: candidate.lastObservedStatus,
    lastObservedUpdatedAt: Math.max(0, Math.trunc(candidate.lastObservedUpdatedAt)),
    lastSeenItemCount: Math.min(totalItemCount, Math.max(0, Math.trunc(candidate.lastSeenItemCount))),
    totalItemCount,
  };
}

export function readStoredExpandedDirectories(projectId = "") {
  try {
    const storageKey = projectId ? `${EXPANDED_DIRECTORIES_STORAGE_KEY}:${projectId}` : EXPANDED_DIRECTORIES_STORAGE_KEY;
    const rawValue = window.localStorage.getItem(storageKey);
    if (!rawValue) {
      return [""];
    }

    const parsedValue = JSON.parse(rawValue);
    if (!Array.isArray(parsedValue)) {
      return [""];
    }

    const normalizedPaths = parsedValue
      .filter((value): value is string => typeof value === "string")
      .sort((left, right) => left.localeCompare(right));

    return normalizedPaths.length > 0 ? normalizedPaths : [""];
  } catch {
    return [""];
  }
}

export function persistExpandedDirectories(expandedDirectories: Iterable<string>, projectId = "") {
  try {
    const storageKey = projectId ? `${EXPANDED_DIRECTORIES_STORAGE_KEY}:${projectId}` : EXPANDED_DIRECTORIES_STORAGE_KEY;
    const serialized = JSON.stringify(Array.from(expandedDirectories).sort((left, right) => left.localeCompare(right)));
    window.localStorage.setItem(storageKey, serialized);
  } catch {
    // Ignore storage failures and keep the in-memory explorer state working.
  }
}

export function readStoredFontSize() {
  try {
    const rawValue = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    if (!rawValue) {
      return DEFAULT_EDITOR_FONT_SIZE;
    }

    const numericValue = Number.parseFloat(rawValue);
    if (Number.isNaN(numericValue)) {
      return DEFAULT_EDITOR_FONT_SIZE;
    }

    return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, numericValue));
  } catch {
    return DEFAULT_EDITOR_FONT_SIZE;
  }
}

export function persistFontSize(fontSize: number) {
  try {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
  } catch {
    // Ignore storage failures and keep the in-memory zoom state working.
  }
}

export function readStoredHarness(): WorkbenchHarness {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_STORAGE_KEY);
    return rawValue === "copilot" ? "copilot" : "codex";
  } catch {
    return "codex";
  }
}

export function persistHarness(harness: WorkbenchHarness) {
  try {
    window.localStorage.setItem(HARNESS_STORAGE_KEY, harness);
  } catch {
    // Ignore storage failures and keep the in-memory harness state working.
  }
}

export function readStoredHarnessModel(harness: WorkbenchHarness) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_MODEL_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return null;
    }

    const selectedModel = parsedValue[harness];
    return typeof selectedModel === "string" && selectedModel.trim() ? selectedModel : null;
  } catch {
    return null;
  }
}

export function persistHarnessModel(harness: WorkbenchHarness, model: string) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_MODEL_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : {};
    const nextValue = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, string>
      : {};

    nextValue[harness] = model;
    window.localStorage.setItem(HARNESS_MODEL_STORAGE_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage failures and keep the in-memory model state working.
  }
}

export function readStoredHarnessModelEffort(harness: WorkbenchHarness, model: string | null) {
  if (!model) {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(HARNESS_MODEL_EFFORT_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return null;
    }

    const selectedHarness = parsedValue[harness];
    if (!selectedHarness || typeof selectedHarness !== "object" || Array.isArray(selectedHarness)) {
      return null;
    }

    const selectedEffort = selectedHarness[model];
    return typeof selectedEffort === "string" && selectedEffort.trim() ? selectedEffort : null;
  } catch {
    return null;
  }
}

export function persistHarnessModelEffort(harness: WorkbenchHarness, model: string, effort: string | null) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_MODEL_EFFORT_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : {};
    const nextValue = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, Record<string, string | null>>
      : {};
    const nextHarnessValue = nextValue[harness] && typeof nextValue[harness] === "object" && !Array.isArray(nextValue[harness])
      ? nextValue[harness]
      : {};

    nextHarnessValue[model] = effort;
    nextValue[harness] = nextHarnessValue;
    window.localStorage.setItem(HARNESS_MODEL_EFFORT_STORAGE_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage failures and keep the in-memory effort state working.
  }
}

export function readStoredHarnessAgent(harness: WorkbenchHarness) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_AGENT_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return null;
    }

    const selectedAgent = parsedValue[harness];
    return typeof selectedAgent === "string" && selectedAgent.trim() ? selectedAgent : null;
  } catch {
    return null;
  }
}

export function persistHarnessAgent(harness: WorkbenchHarness, agentPath: string | null) {
  try {
    const rawValue = window.localStorage.getItem(HARNESS_AGENT_STORAGE_KEY);
    const parsedValue = rawValue ? JSON.parse(rawValue) : {};
    const nextValue = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue as Record<string, string | null>
      : {};

    nextValue[harness] = agentPath;
    window.localStorage.setItem(HARNESS_AGENT_STORAGE_KEY, JSON.stringify(nextValue));
  } catch {
    // Ignore storage failures and keep the in-memory agent state working.
  }
}

export function readStoredThreadUnreadState() {
  try {
    const rawValue = window.localStorage.getItem(THREAD_UNREAD_STATE_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsedValue = JSON.parse(rawValue);
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsedValue).flatMap(([key, value]) => {
        const normalizedValue = normalizeStoredThreadUnreadState(value);
        return normalizedValue ? [[key, normalizedValue]] : [];
      }),
    );
  } catch {
    return {};
  }
}

export function persistThreadUnreadState(stateByKey: Record<string, WorkbenchStoredThreadUnreadState>) {
  try {
    window.localStorage.setItem(THREAD_UNREAD_STATE_STORAGE_KEY, JSON.stringify(stateByKey));
  } catch {
    // Ignore storage failures and keep the in-memory unread badge state working.
  }
}

export function readStoredThreadLiveActivityOpen() {
  try {
    return window.localStorage.getItem(THREAD_LIVE_ACTIVITY_OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function persistThreadLiveActivityOpen(isOpen: boolean) {
  try {
    window.localStorage.setItem(THREAD_LIVE_ACTIVITY_OPEN_STORAGE_KEY, isOpen ? "true" : "false");
  } catch {
    // Ignore storage failures and keep the in-memory disclosure state working.
  }
}

export function readCurrentSelectionFromUrl(): WorkbenchSelectionSearchParams {
  try {
    const url = new URL(window.location.href);
    const routeSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const markerIndex = routeSegments.indexOf(WORKBENCH_ROUTE_MARKER);
    if (markerIndex >= 0) {
      const projectId = decodeWorkbenchRouteSegments(routeSegments.slice(0, markerIndex));
      const mode = routeSegments[markerIndex + 1] ?? "";
      const value = decodeWorkbenchRouteSegments(routeSegments.slice(markerIndex + 2));
      return {
        filePath: mode === "file" ? value : "",
        projectId,
        threadId: mode === "thread" ? value : "",
      };
    }

    const projectId = decodeWorkbenchRouteSegments(routeSegments);
    return {
      filePath: url.searchParams.get(CURRENT_FILE_SEARCH_PARAM) ?? "",
      projectId,
      threadId: url.searchParams.get(CURRENT_THREAD_SEARCH_PARAM) ?? "",
    };
  } catch {
    return emptySelection();
  }
}

export function readLocalWorkbenchOrigin() {
  const explicitOrigin = process.env.NEXT_PUBLIC_LOCAL_WORKBENCH_ORIGIN?.trim();
  if (explicitOrigin) {
    return explicitOrigin.replace(/\/$/, "");
  }

  try {
    const currentUrl = new URL(window.location.href);
    const port = currentUrl.port || (currentUrl.protocol === "https:" ? "443" : "80");
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

export function getRequestedPathFromUrl() {
  return readCurrentSelectionFromUrl().filePath;
}

export function getRequestedProjectIdFromUrl() {
  return readCurrentSelectionFromUrl().projectId;
}

export function getRequestedThreadIdFromUrl() {
  return readCurrentSelectionFromUrl().threadId;
}

export function syncCurrentSelectionToUrl({
  filePath = "",
  projectId,
  threadId = "",
}: {
  filePath?: string;
  projectId?: string;
  threadId?: string;
}) {
  try {
    const url = new URL(window.location.href);
    const currentUrl = `${url.pathname}${url.search}${url.hash}`;
    const currentSelection = readCurrentSelectionFromUrl();
    const nextProjectId = projectId ?? currentSelection.projectId;
    const projectPath = encodeWorkbenchRoutePath(nextProjectId);
    const selectionPath = threadId
      ? `${projectPath}/${WORKBENCH_ROUTE_MARKER}/thread/${encodeWorkbenchRoutePath(threadId)}`
      : filePath
        ? `${projectPath}/${WORKBENCH_ROUTE_MARKER}/file/${encodeWorkbenchRoutePath(filePath)}`
        : projectPath;

    url.pathname = `/${selectionPath}`;
    url.searchParams.delete(CURRENT_FILE_SEARCH_PARAM);
    url.searchParams.delete(CURRENT_THREAD_SEARCH_PARAM);

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (nextUrl === currentUrl) {
      return;
    }

    window.history.replaceState(window.history.state, "", nextUrl);
    window.dispatchEvent(new CustomEvent<WorkbenchSelectionSearchParams>(CURRENT_SELECTION_URL_UPDATED_EVENT, {
      detail: {
        filePath,
        projectId: nextProjectId,
        threadId,
      },
    }));
  } catch {
    // Ignore URL update failures and keep the editor working.
  }
}
