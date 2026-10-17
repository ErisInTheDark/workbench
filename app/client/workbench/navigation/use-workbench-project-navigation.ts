/*
 * Exports:
 * - WorkbenchHrefOptions: selection intent, mobile sidebar persistence and tab strip placement for one destination.
 * - WorkbenchNavigateOptions: href options plus history replacement.
 * - useWorkbenchNavigationState: the url route, focused tab, tab strip and navigator behind hrefs and tab controls.
 * - useWorkbenchProjectNavigation: bind public href generation (path plus tab strip) to the mounted project navigator, re-rendering when its addresses change.
 * - useWorkbenchNavigate: push or replace a destination through the same hrefs links render.
 * - useWorkbenchSwapTab: turn the focused tab into another destination in place, as a new history entry.
 */
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import WorkbenchClientContext, { type WorkbenchClientController } from "../../components/workbench/workbench-client-context";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../../components/workbench/workbench-client-state-context";
import { formatWorkbenchTab, parseWorkbenchRouteFromPath, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { WorkbenchTabStrip } from "workbench-shared/workbench/navigation/workbench-tabs";
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
  /** How the destination joins the tab strip: replace the preview tab (default), open a kept tab, or use a given strip. */
  tab?: "preview" | "durable" | { strip: WorkbenchTabStrip };
}

export interface WorkbenchNavigateOptions extends WorkbenchHrefOptions {
  /** Replaces history; the destination also takes over the current tab, as a draft becoming a thread does. */
  replace?: boolean;
}

/** The url-derived route, tab strip and navigator every href and tab control reads. */
export function useWorkbenchNavigationState(explicitClient?: WorkbenchClientController) {
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
  const navigation = useMemo(() => mounted ?? new WorkbenchProjectNavigation([], state.getProjectAliases(), [],
    threadId => {
      const owner = client?.mounted?.threadOwnerFor(threadId);
      return owner ? { daemonId: owner.daemonId, projectId: ProjectIdSchema.parse(owner.projectId) } : null;
    }), [client, mounted, state]);
  // The url's active tab exactly as written, so it always matches its entry in the url's strip.
  const currentTab = useMemo(() => formatWorkbenchTab(current), [current]);
  // A url without a strip is its one durable active tab.
  const strip = useMemo(() => currentTab === undefined ? current.tabStrip ?? WorkbenchTabStrip.empty
    : WorkbenchTabStrip.open(current.tabStrip ?? { tabs: [currentTab], preview: null }, currentTab), [current, currentTab]);
  return { current, currentTab, navigation, revision, search, strip };
}

export function useWorkbenchProjectNavigation(explicitClient?: WorkbenchClientController) {
  const { current, currentTab, navigation, revision, search, strip } = useWorkbenchNavigationState(explicitClient);
  return useCallback((route: WorkbenchRoute, options: WorkbenchNavigateOptions = {}) => {
    const tab = typeof options.tab === "object" ? undefined : navigation.tabFor(route, current);
    const tabStrip = typeof options.tab === "object" ? options.tab.strip
      : tab === undefined ? strip
        : options.replace && currentTab !== undefined ? WorkbenchTabStrip.replace(strip, currentTab, tab)
          : WorkbenchTabStrip.open(strip, tab, { durable: options.tab === "durable", focused: currentTab ?? null });
    const href = navigation.href({ ...route, tabStrip }, current, options.selection ?? "inherit");
    if (href === undefined) return undefined;
    // Canonical replacements keep the mobile sidebar open too, so a reload there returns to the sidebar.
    const keepSidebar = (options.replace || (options.keepMobileSidebar && keepsMobileMainPane(current, route)))
      && isMobileSidebarRequested(search);
    return keepSidebar ? mobileSidebarHref(new URL(href, "http://workbench.local")) : href;
  }, [navigation, current, currentTab, search, strip, revision]);
}

/**
 * Turn the focused tab into another destination in place (a file into its folder index, a document into its sibling),
 * as a new history entry so back returns to it.
 */
export function useWorkbenchSwapTab(explicitClient?: WorkbenchClientController) {
  const { current, currentTab, navigation, strip } = useWorkbenchNavigationState(explicitClient);
  const navigate = useWorkbenchNavigate(explicitClient);
  return useCallback((route: WorkbenchRoute) => {
    const next = navigation.tabFor(route, current);
    navigate(route, next && currentTab ? { tab: { strip: WorkbenchTabStrip.replace(strip, currentTab, next) } } : {});
  }, [current, currentTab, navigate, navigation, strip]);
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
