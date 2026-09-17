/**
 * Exports:
 * - getPreferredMobilePane: choose the visible pane from viewport and route state.
 * - MOBILE_MEDIA_QUERY: shared mobile viewport breakpoint.
 * - MobilePane: sidebar or content pane.
 */

import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";

export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

export type MobilePane = "editor" | "explorer";

export function getPreferredMobilePane (isMobileViewport: boolean, route: WorkbenchRoute): MobilePane {
  if (!isMobileViewport) {
    return "editor";
  }

  return route.view === "file" || route.view === "thread" || route.view === "settings" || route.view === "stats" || route.view === "mosaic" || route.view === "git" ? "editor" : "explorer";
}
