/**
 * Exports:
 * - getPreferredMobilePane: choose the preferred mobile pane from viewport state and route state. Keywords: responsive, mobile, explorer, editor, route.
 */

import type { WorkbenchRoute } from "../navigation/workbench-route";

export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

export type MobilePane = "editor" | "explorer";

export function getPreferredMobilePane (isMobileViewport: boolean, route: WorkbenchRoute): MobilePane {
  if (!isMobileViewport) {
    return "editor";
  }

  return route.view === "file" || route.view === "thread" || route.view === "settings" || route.view === "mosaic" ? "editor" : "explorer";
}
