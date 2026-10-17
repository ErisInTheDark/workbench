/*
 * Exports:
 * - WorkbenchTabTap: one touch release on a tab.
 * - isWorkbenchTabDoubleTap: whether a touch release completes a double tap on the same tab.
 */

export interface WorkbenchTabTap {
  tab: string;
  atMs: number;
}

/** Touch browsers do not reliably fire dblclick, so tabs pair their own taps. */
const DOUBLE_TAP_WINDOW_MS = 350;

export function isWorkbenchTabDoubleTap(previous: WorkbenchTabTap | null, next: WorkbenchTabTap) {
  return previous !== null && previous.tab === next.tab && next.atMs - previous.atMs <= DOUBLE_TAP_WINDOW_MS;
}
