/**
 * Exports:
 * - getCurrentSelectionSearchParams: read the current file and thread URL search params. Keywords: mobile pane, URL state, search params, file, thread.
 * - syncCurrentSelectionSearchParams: update the current file and thread URL search params without navigation. Keywords: history.replaceState, URL sync, selection state, file, thread.
 * - getPreferredMobilePane: choose the preferred mobile pane from viewport state and current URL selection. Keywords: responsive, mobile, explorer, editor, selection.
 */

import {
    readCurrentSelectionFromUrl,
    syncCurrentSelectionToUrl,
    type WorkbenchSelectionSearchParams,
} from "./browser-state";

export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

export type MobilePane = "editor" | "explorer";

export function getCurrentSelectionSearchParams (): WorkbenchSelectionSearchParams {
  return readCurrentSelectionFromUrl();
}

export function syncCurrentSelectionSearchParams ({
  filePath = "",
  threadId = "",
}: {
  filePath?: string;
  threadId?: string;
}) {
  syncCurrentSelectionToUrl({ filePath, threadId });
}

export function getPreferredMobilePane (isMobileViewport: boolean): MobilePane {
  if (!isMobileViewport) {
    return "editor";
  }

  const { filePath, threadId } = readCurrentSelectionFromUrl();
  return filePath || threadId ? "editor" : "explorer";
}
