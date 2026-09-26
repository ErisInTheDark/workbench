/**
 * Exports:
 * - getPreferredMobilePane: choose the visible pane from viewport and route state.
 * - getMobileExplorerRoute: return to the project selected by a mobile route.
 * - MOBILE_MEDIA_QUERY: shared mobile viewport breakpoint.
 * - MobilePane: sidebar or content pane.
 */

import {
  createHomeRoute, createLogicalProjectRoute, createProjectRoute, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";

export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

export type MobilePane = "editor" | "explorer";

export function getMobileExplorerRoute(route: WorkbenchRoute, browseProjectId = ""): WorkbenchRoute {
  if (route.logical) return route.logical.projectId
    ? createLogicalProjectRoute(route.logical.projectId)
    : createHomeRoute();
  if (route.view === "thread" && !route.projectId) return createHomeRoute();
  return createProjectRoute(route.projectId || browseProjectId);
}

export function getPreferredMobilePane (isMobileViewport: boolean, route: WorkbenchRoute): MobilePane {
  if (!isMobileViewport) {
    return "editor";
  }

  return route.view === "file" || route.view === "thread" || route.view === "settings" || route.view === "stats" || route.view === "mosaic" || route.view === "git" ? "editor" : "explorer";
}
