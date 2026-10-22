/*
 * Exports:
 * - WorkbenchSidebarPanel: the content the sidebar shows between its fixed header and status footer.
 * - sidebarPanelForRoute: the panel a desktop tab brings forward; null for tabs that leave the panel alone.
 */
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";

export type WorkbenchSidebarPanel = "threads" | "git" | "explorer" | "reload";

const EXPLORER_FILE = /\.(?:md|markdown|svg)$/iu;

export function sidebarPanelForRoute(route: Pick<WorkbenchRoute, "view" | "filePath">): WorkbenchSidebarPanel | null {
  if (route.view === "thread") return "threads";
  if (route.view === "git") return "git";
  if (route.view === "file" && route.filePath && EXPLORER_FILE.test(route.filePath)) return "explorer";
  return null;
}
