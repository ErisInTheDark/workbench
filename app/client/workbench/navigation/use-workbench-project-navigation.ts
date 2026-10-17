/*
 * Exports:
 * - WorkbenchHrefOptions: selection intent and mobile sidebar persistence for one destination.
 * - WorkbenchNavigateOptions: href options plus history replacement.
 * - useWorkbenchProjectNavigation: bind public href generation to the mounted project navigator, re-rendering when its addresses change.
 * - useWorkbenchNavigate: push or replace a destination through the same hrefs links render.
 */
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import WorkbenchClientContext, { type WorkbenchClientController } from "../../components/workbench/workbench-client-context";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../../components/workbench/workbench-client-state-context";
import { parseWorkbenchRouteFromPath, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { isMobileSidebarRequested, keepsMobileMainPane, mobileSidebarHref } from "../state/mobile-pane-url-state";
import { usePathname, useSearchParams } from "./browser-navigation";
import WorkbenchProjectNavigation from "./workbench-project-navigation";

const NO_REVISION = () => 0;
const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};

export interface WorkbenchHrefOptions {
  /** `exact` replaces the sidebar selection with the destination's own; default keeps it. */
  selection?: "inherit" | "exact";
  /** A sidebar-only change (project or folder selection) keeps an open mobile sidebar open over the same main pane. */
  keepMobileSidebar?: boolean;
}

export interface WorkbenchNavigateOptions extends WorkbenchHrefOptions {
  replace?: boolean;
}

export function useWorkbenchProjectNavigation(explicitClient?: WorkbenchClientController) {
  const context = useContext(WorkbenchClientContext);
  const client = explicitClient ?? context;
  const state = useWorkbenchClientStateController();
  useWorkbenchClientStateSnapshot();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const current = useMemo(() => parseWorkbenchRouteFromPath(pathname, search), [pathname, search]);
  const mounted = client?.mounted?.projectNavigator ?? null;
  const revision = useSyncExternalStore(mounted?.subscribe ?? EMPTY_SUBSCRIBE,
    mounted?.getRevision ?? NO_REVISION, NO_REVISION);
  // Before mount there are no catalogues yet, so only aliases resolve.
  const navigation = mounted ?? new WorkbenchProjectNavigation([], state.getProjectAliases(), [],
    threadId => {
      const owner = client?.mounted?.threadOwnerFor(threadId);
      return owner ? { daemonId: owner.daemonId, projectId: ProjectIdSchema.parse(owner.projectId) } : null;
    });
  return useCallback((route: WorkbenchRoute, options: WorkbenchNavigateOptions = {}) => {
    const href = navigation.href(route, current, options.selection ?? "inherit");
    // Canonical replacements keep the mobile sidebar open too, so a reload there returns to the sidebar.
    const keepSidebar = (options.replace || (options.keepMobileSidebar && keepsMobileMainPane(current, route)))
      && isMobileSidebarRequested(search);
    return href !== undefined && keepSidebar ? mobileSidebarHref(new URL(href, "http://workbench.local")) : href;
  }, [navigation, current, search, revision]);
}

export function useWorkbenchNavigate(explicitClient?: WorkbenchClientController) {
  const href = useWorkbenchProjectNavigation(explicitClient);
  return useCallback((route: WorkbenchRoute, options: WorkbenchNavigateOptions = {}) => {
    const nextHref = href(route, options);
    if (nextHref === undefined || nextHref === `${window.location.pathname}${window.location.search}`) return;
    if (options.replace) window.history.replaceState({ workbench: true }, "", nextHref);
    else window.history.pushState({ workbench: true }, "", nextHref);
  }, [href]);
}
