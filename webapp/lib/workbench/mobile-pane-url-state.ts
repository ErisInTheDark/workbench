/**
 * Exports:
 * - getCurrentSelectionSearchParams: read the current file and thread URL search params. Keywords: mobile pane, URL state, search params, file, thread.
 * - syncCurrentSelectionSearchParams: update the current file and thread URL search params without navigation. Keywords: history.replaceState, URL sync, selection state, file, thread.
 * - getPreferredMobilePane: choose the preferred mobile pane from viewport state and current URL selection. Keywords: responsive, mobile, explorer, editor, selection.
 */

export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

export type MobilePane = "editor" | "explorer";

export const FILE_SEARCH_PARAM = "file";
export const THREAD_SEARCH_PARAM = "thread";

export function getCurrentSelectionSearchParams () {
  if (typeof window === "undefined") {
    return {
      filePath: "",
      threadId: "",
    };
  }

  try {
    const url = new URL(window.location.href);
    return {
      filePath: url.searchParams.get(FILE_SEARCH_PARAM) ?? "",
      threadId: url.searchParams.get(THREAD_SEARCH_PARAM) ?? "",
    };
  } catch {
    return {
      filePath: "",
      threadId: "",
    };
  }
}

export function syncCurrentSelectionSearchParams ({
  filePath = "",
  threadId = "",
}: {
  filePath?: string;
  threadId?: string;
}) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const url = new URL(window.location.href);
    if (filePath) {
      url.searchParams.set(FILE_SEARCH_PARAM, filePath);
    } else {
      url.searchParams.delete(FILE_SEARCH_PARAM);
    }

    if (threadId) {
      url.searchParams.set(THREAD_SEARCH_PARAM, threadId);
    } else {
      url.searchParams.delete(THREAD_SEARCH_PARAM);
    }

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  } catch {
    // Ignore URL update failures and keep the workbench usable.
  }
}

export function getPreferredMobilePane (isMobileViewport: boolean): MobilePane {
  if (!isMobileViewport) {
    return "editor";
  }

  const { filePath, threadId } = getCurrentSelectionSearchParams();
  return filePath || threadId ? "editor" : "explorer";
}
