/**
 * Exports:
 * - DEFAULT_EDITOR_FONT_SIZE, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE: editor font size defaults and bounds. Keywords: editor zoom, font size, clamp.
 * - CURRENT_FILE_SEARCH_PARAM, CURRENT_THREAD_SEARCH_PARAM: URL search param names for current workbench selection. Keywords: URL state, file, thread.
 * - EXPANDED_DIRECTORIES_STORAGE_KEY, FONT_SIZE_STORAGE_KEY: localStorage keys for persisted explorer and editor browser state. Keywords: localStorage, explorer, font size.
 * - readStoredExpandedDirectories: read and normalize persisted expanded directory paths. Keywords: localStorage, explorer tree, expanded directories, browser state.
 * - persistExpandedDirectories: persist expanded directory paths from a provided collection. Keywords: localStorage, explorer tree, persistence, directories.
 * - readStoredFontSize: read and clamp the persisted editor font size. Keywords: localStorage, editor zoom, font size, clamp.
 * - persistFontSize: persist a provided editor font size value. Keywords: localStorage, editor zoom, persistence.
 * - getRequestedPathFromUrl: read the requested file path from the current URL. Keywords: URL state, search params, file selection.
 * - getRequestedThreadIdFromUrl: read the requested thread id from the current URL. Keywords: URL state, search params, thread selection.
 * - syncCurrentSelectionToUrl: update the current file and thread URL search params without navigation. Keywords: history.replaceState, URL sync, selection state, file, thread.
 */

export const DEFAULT_EDITOR_FONT_SIZE = 1.08;
export const MIN_EDITOR_FONT_SIZE = 0.84;
export const MAX_EDITOR_FONT_SIZE = 1.72;
export const CURRENT_FILE_SEARCH_PARAM = "file";
export const CURRENT_THREAD_SEARCH_PARAM = "thread";
export const EXPANDED_DIRECTORIES_STORAGE_KEY = "workbench:expanded-directories";
export const FONT_SIZE_STORAGE_KEY = "workbench:font-size";

export function readStoredExpandedDirectories() {
  try {
    const rawValue = window.localStorage.getItem(EXPANDED_DIRECTORIES_STORAGE_KEY);
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

export function persistExpandedDirectories(expandedDirectories: Iterable<string>) {
  try {
    const serialized = JSON.stringify(Array.from(expandedDirectories).sort((left, right) => left.localeCompare(right)));
    window.localStorage.setItem(EXPANDED_DIRECTORIES_STORAGE_KEY, serialized);
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

export function getRequestedPathFromUrl() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get(CURRENT_FILE_SEARCH_PARAM) ?? "";
  } catch {
    return "";
  }
}

export function getRequestedThreadIdFromUrl() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get(CURRENT_THREAD_SEARCH_PARAM) ?? "";
  } catch {
    return "";
  }
}

export function syncCurrentSelectionToUrl({
  filePath = "",
  threadId = "",
}: {
  filePath?: string;
  threadId?: string;
}) {
  try {
    const url = new URL(window.location.href);
    if (filePath) {
      url.searchParams.set(CURRENT_FILE_SEARCH_PARAM, filePath);
    } else {
      url.searchParams.delete(CURRENT_FILE_SEARCH_PARAM);
    }

    if (threadId) {
      url.searchParams.set(CURRENT_THREAD_SEARCH_PARAM, threadId);
    } else {
      url.searchParams.delete(CURRENT_THREAD_SEARCH_PARAM);
    }

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  } catch {
    // Ignore URL update failures and keep the editor working.
  }
}
