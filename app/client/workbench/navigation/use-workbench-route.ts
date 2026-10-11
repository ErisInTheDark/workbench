/*
 * Exports:
 * - useWorkbenchRoute: derive routes from browser history and expose guarded canonical navigation.
 * - useWorkbenchRouteIntent: apply one URL-derived route intent and its canonical replacement.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { usePathname, useSearchParams } from "./browser-navigation";
import {
  type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchClientController } from "../../components/workbench/workbench-client-context";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../../components/workbench/workbench-client-state-context";
import WorkbenchProjectNavigation from "./workbench-project-navigation";
import { useWorkbenchProjectNavigation } from "./use-workbench-project-navigation";
import { isMobileSidebarRequested, keepsMobileMainPane, mobileSidebarHref } from "../state/mobile-pane-url-state";
import {
  readWorkbenchLaunchSelection,
  WORKBENCH_LAST_PROJECT_SELECTION_SCHEMA_VERSION,
} from "workbench-shared/state/workbench-client-state";
import { LogicalProjectIdSchema, type LogicalProjectId } from "workbench-shared/workbench/identity";

const emptySubscribe = (_listener: () => void) => () => {};

export function useWorkbenchRoute(client: WorkbenchClientController) {
  const state = useWorkbenchClientStateController();
  const stateSnapshot = useWorkbenchClientStateSnapshot();
  const href = useWorkbenchProjectNavigation(client);
  const navigation = client.mounted?.navigation;
  const navigationState = useSyncExternalStore(
    navigation?.subscribe ?? emptySubscribe,
    navigation?.getSnapshot ?? (() => null),
    () => null,
  );
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const locationSnapshot = useMemo(
    () => `${pathname || "/"}${search ? `?${search}` : ""}`,
    [pathname, search],
  );
  const launchSelection = readWorkbenchLaunchSelection(stateSnapshot.records);
  const launchSelectionKey = typeof launchSelection === "string"
    ? `legacy\0${launchSelection}`
    : launchSelection === null
      ? "unfiltered"
      : launchSelection === undefined
        ? "absent"
        : `explicit\0${launchSelection.join("\0")}`;
  const resolved = (client.mounted?.projectNavigator ?? new WorkbenchProjectNavigation([], state.getProjectAliases()))
    .readRoute(locationSnapshot, launchSelection);
  const route = useMemo(() => resolved, [
    locationSnapshot, resolved.projectId, resolved.threadOwnerProjectId,
    resolved.selectedProjectIds?.join("\0") ?? null,
    resolved.logical?.projectId, resolved.logical?.threadOwnerProjectId,
    resolved.view, resolved.error, pathname === "/launch" ? launchSelectionKey : undefined,
  ]);

  const navigateToRoute = useCallback((nextRoute: WorkbenchRoute,
    options: {
      replace?: boolean; selection?: "inherit" | "exact";
      /** A sidebar-only change (project or folder selection) keeps an open mobile sidebar open over the same main pane. */
      keepMobileSidebar?: boolean;
    } = {}) => {
    const routeHref = href(nextRoute, options.selection);
    // Canonical replacements keep the mobile sidebar open too, so a reload there returns to the sidebar.
    const keepSidebar = (options.replace || (options.keepMobileSidebar && keepsMobileMainPane(route, nextRoute)))
      && isMobileSidebarRequested(window.location.search);
    const nextHref = routeHref !== undefined && keepSidebar
      ? mobileSidebarHref(new URL(routeHref, window.location.origin)) : routeHref;
    if (nextHref === undefined || nextHref === locationSnapshot) {
      return;
    }

    if (options.replace) {
      window.history.replaceState({ workbench: true }, "", nextHref);
    } else {
      window.history.pushState({ workbench: true }, "", nextHref);
    }
  }, [href, locationSnapshot, route]);

  useEffect(() => {
    // Prefer the catalogue once available, including when an old junction URL
    // was opened directly. Never replace newer user navigation.
    if (!client.controls || `${window.location.pathname}${window.location.search}` !== locationSnapshot) return;
    if (pathname === "/launch") {
      navigateToRoute(route, { replace: true });
      return;
    }
    const canonical = href(route);
    if (!canonical) return;
    const canonicalPath = new URL(canonical, window.location.origin).pathname;
    if (pathname !== "/" && pathname !== "/@/" && canonicalPath !== pathname) {
      window.history.replaceState({ workbench: true }, "", `${canonicalPath}${window.location.search}${window.location.hash}`);
    }
  }, [pathname, locationSnapshot, client.controls, href, navigateToRoute, route]);

  const selectedProjectIdsKey = route.selectedProjectIds === null
    ? "unfiltered"
    : `explicit\0${route.selectedProjectIds.join("\0")}`;
  const storedSelection = stateSnapshot.records.find(record => record.kind === "lastProjectSelection");
  const storedSelectionKey = storedSelection?.selectedProjectIds === null
    ? "unfiltered"
    : storedSelection
      ? `explicit\0${storedSelection.selectedProjectIds.join("\0")}`
      : "absent";
  useEffect(() => {
    if (stateSnapshot.schemaVersion < WORKBENCH_LAST_PROJECT_SELECTION_SCHEMA_VERSION
      || route.view === "invalid"
      || selectedProjectIdsKey === storedSelectionKey
      || (route.selectedProjectIds?.length && !route.logical)) return;
    let selectedProjectIds: LogicalProjectId[] | null = null;
    if (route.selectedProjectIds !== null) {
      selectedProjectIds = [];
      for (const projectId of route.selectedProjectIds) {
        const parsed = LogicalProjectIdSchema.safeParse(projectId);
        if (!parsed.success) return;
        selectedProjectIds.push(parsed.data);
      }
    }
    void state.put({ kind: "lastProjectSelection", selectedProjectIds }).catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown app-state mutation failure.";
      console.warn("Workbench last project selection could not be saved.", message.slice(0, 500));
    });
  }, [
    route.logical,
    route.selectedProjectIds,
    route.view,
    selectedProjectIdsKey,
    state,
    stateSnapshot.schemaVersion,
    storedSelectionKey,
  ]);

  return {
    navigateToRoute,
    navigationState,
    route,
  };
}

export function useWorkbenchRouteIntent(
  client: WorkbenchClientController,
  intent: WorkbenchRoute,
  navigateToRoute: (route: WorkbenchRoute, options?: { replace?: boolean }) => void,
) {
  const navigate = useRef(navigateToRoute);
  navigate.current = navigateToRoute;
  useEffect(() => {
    const routes = client.mounted?.routeIntents;
    if (!routes) return;
    const unsubscribe = routes.subscribeCanonical(route => navigate.current(route, { replace: true }));
    routes.request(intent);
    return unsubscribe;
  }, [client.mounted, intent]);
}
