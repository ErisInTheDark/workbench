/*
 * Exports:
 * - SvgTabList: ordered file tabs and the focused index.
 * - sameFileTab: compare tabs by path and folder address.
 * - openFileTab: focus an already-open tab or append a new one after the focused tab.
 * - closeFileTab: drop one tab, focusing its right neighbour (or left at the end); null when none remain.
 * - replaceFileTab: swap one tab for another (save as), merging into an existing copy of the replacement.
 */
import type { WorkbenchFileTab } from "workbench-shared/workbench/navigation/workbench-route";

export interface SvgTabList {
  tabs: readonly WorkbenchFileTab[];
  index: number;
}

export function sameFileTab(left: WorkbenchFileTab, right: WorkbenchFileTab) {
  return left.filePath === right.filePath
    && (left.folderAddress ?? []).join("/") === (right.folderAddress ?? []).join("/");
}

export function openFileTab(list: SvgTabList, tab: WorkbenchFileTab): SvgTabList {
  const existing = list.tabs.findIndex(candidate => sameFileTab(candidate, tab));
  if (existing >= 0) return { tabs: list.tabs, index: existing };
  const insertAt = list.tabs.length ? list.index + 1 : 0;
  return { tabs: [...list.tabs.slice(0, insertAt), tab, ...list.tabs.slice(insertAt)], index: insertAt };
}

export function closeFileTab(list: SvgTabList, index: number): SvgTabList | null {
  const tabs = list.tabs.filter((_tab, candidate) => candidate !== index);
  if (!tabs.length) return null;
  const focused = index < list.index ? list.index - 1 : index === list.index ? Math.min(index, tabs.length - 1) : list.index;
  return { tabs, index: focused };
}

export function replaceFileTab(list: SvgTabList, index: number, tab: WorkbenchFileTab): SvgTabList {
  const duplicate = list.tabs.findIndex((candidate, position) => position !== index && sameFileTab(candidate, tab));
  if (duplicate >= 0) {
    const closed = closeFileTab(list, index)!;
    return { tabs: closed.tabs, index: closed.tabs.findIndex(candidate => sameFileTab(candidate, tab)) };
  }
  return { tabs: list.tabs.map((candidate, position) => position === index ? tab : candidate), index };
}
