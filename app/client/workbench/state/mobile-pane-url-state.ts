/**
 * Exports:
 * - getPreferredMobilePane: choose the visible pane from viewport, route state and the sidebar request in the url.
 * - isMobileSidebarRequested: whether a url search asks for the sidebar over the route's main pane.
 * - mobileSidebarHref: the current location with the sidebar requested, keeping its main pane route.
 * - keepsMobileMainPane: whether a navigation changes only sidebar state, so an open sidebar stays open.
 * - MOBILE_MEDIA_QUERY: shared mobile viewport breakpoint.
 * - MobilePane: sidebar or content pane.
 */

import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";

export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

export type MobilePane = "editor" | "explorer";

const SIDEBAR_PARAM = "pane";
const SIDEBAR_VALUE = "sidebar";

export function isMobileSidebarRequested(search: string) {
  return new URLSearchParams(search).get(SIDEBAR_PARAM) === SIDEBAR_VALUE;
}

/** Showing the sidebar over a thread keeps its route, so the thread stays mounted and a reload returns here. */
export function mobileSidebarHref(location: Pick<Location, "pathname" | "search" | "hash">) {
  const search = new URLSearchParams(location.search);
  search.set(SIDEBAR_PARAM, SIDEBAR_VALUE);
  return `${location.pathname}?${search.toString()}${location.hash}`;
}

/** Whether a navigation leaves the main pane's content as it is, changing only sidebar state such as project selection. */
export function keepsMobileMainPane(current: WorkbenchRoute, next: WorkbenchRoute) {
  return current.view === next.view && current.filePath === next.filePath && current.statsTab === next.statsTab
    && areDeeplyEqual(current.threadTarget, next.threadTarget) && areDeeplyEqual(current.mosaicNode, next.mosaicNode);
}

export function getPreferredMobilePane (isMobileViewport: boolean, route: WorkbenchRoute, sidebarRequested = false): MobilePane {
  if (!isMobileViewport) {
    return "editor";
  }
  if (sidebarRequested) return "explorer";

  return route.view === "file" || route.view === "thread" || route.view === "settings" || route.view === "stats" || route.view === "mosaic" || route.view === "git" || route.view === "new-project" ? "editor" : "explorer";
}
