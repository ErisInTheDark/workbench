/*
 * Exports:
 * - WorkbenchActionContext: live browser owners available to registered actions. Keywords: search, action, browser.
 * - runWorkbenchAction/handleWorkbenchActionShortcut: action activation and Ctrl-chord registry. Keywords: search, shortcut, keyboard.
 */
import type { WorkbenchSearchActionId } from "workbench-shared/workbench/search/workbench-search";

export interface WorkbenchActionContext {
  createThread(): void;
  getSidebarThreadLinks(): readonly Pick<HTMLElement, "click">[];
  hasDesktopSidebar?: boolean;
  hasProject: boolean;
  home(): void;
  openSearch(): void;
  openSettings(): void;
  toggleSidebar(): void;
  zoomIn(): void;
  zoomOut(): void;
}

export function runWorkbenchAction(actionId: WorkbenchSearchActionId, context: WorkbenchActionContext) {
  if (actionId.startsWith("view-thread-")) {
    const index = Number.parseInt(actionId.slice("view-thread-".length), 10) - 1;
    const link = context.getSidebarThreadLinks()[index];
    if (!link) return false;
    link.click();
    return true;
  }
  switch (actionId) {
    case "toggle-sidebar":
      if (context.hasDesktopSidebar === false) return false;
      context.toggleSidebar();
      return true;
    case "zoom-in": context.zoomIn(); return true;
    case "zoom-out": context.zoomOut(); return true;
    case "create-thread":
      if (!context.hasProject) return false;
      context.createThread();
      return true;
    case "home": context.home(); return true;
    case "settings": context.openSettings(); return true;
  }
}

function actionForShortcut(event: KeyboardEvent): WorkbenchSearchActionId | "search" | null {
  if (event.defaultPrevented || !event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = event.key.toLocaleLowerCase();
  if (event.repeat && key !== "+" && key !== "=" && key !== "-") return null;
  if (key === "p") return "search";
  if (key === "b") return "toggle-sidebar";
  if (key === "+" || key === "=") return "zoom-in";
  if (key === "-") return "zoom-out";
  if (/^[1-9]$/u.test(key)) return `view-thread-${key}` as WorkbenchSearchActionId;
  if (key === "0") return "view-thread-10";
  if (key === "m") return "create-thread";
  if (key === "h") return "home";
  if (key === "o") return "settings";
  return null;
}

export function handleWorkbenchActionShortcut(event: KeyboardEvent, context: WorkbenchActionContext) {
  const actionId = actionForShortcut(event);
  const handled = actionId === "search" ? (context.openSearch(), true) : actionId ? runWorkbenchAction(actionId, context) : false;
  if (handled) event.preventDefault();
  return handled;
}
