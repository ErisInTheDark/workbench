/**
 * Exports:
 * - getPreferredMobilePane: choose the visible pane from viewport and route state.
 * - getMobileExplorerRoute: return to the project selected by a mobile route.
 * - MOBILE_MEDIA_QUERY: shared mobile viewport breakpoint.
 * - MobilePane: sidebar or content pane.
 */

import {
  createLogicalProjectRoute, createProjectSelectionRoute, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";

export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

export type MobilePane = "editor" | "explorer";

export function getMobileExplorerRoute(route: WorkbenchRoute, browseProjectId = ""): WorkbenchRoute {
  if (route.logical?.projectId && route.selectedProjectIds?.length === 1) {
    return createLogicalProjectRoute(route.logical.projectId);
  }
  return createProjectSelectionRoute(route.selectedProjectIds
    ?? (route.projectId ? [route.projectId] : browseProjectId && route.view !== "thread" ? [browseProjectId] : null));
}

export function getPreferredMobilePane (isMobileViewport: boolean, route: WorkbenchRoute): MobilePane {
  if (!isMobileViewport) {
    return "editor";
  }

  return route.view === "file" || route.view === "thread" || route.view === "settings" || route.view === "stats" || route.view === "mosaic" || route.view === "git" || route.view === "new-project" ? "editor" : "explorer";
}
