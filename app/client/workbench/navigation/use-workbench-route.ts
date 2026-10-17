/*
 * Exports:
 * - canCanonicalizeWorkbenchRoute: keep launch URLs intact until browser app state has loaded.
 * - useWorkbenchRoute: derive routes from browser history, persist local launch selection, and expose guarded canonical navigation.
 * - useWorkbenchRouteIntent: apply one URL-derived route intent and its canonical replacement.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { usePathname, useSearchParams } from "./browser-navigation";
import {
  LEGACY_TAB_SEARCH_PARAMS, type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchClientController } from "../../components/workbench/workbench-client-context";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../../components/workbench/workbench-client-state-context";
import WorkbenchProjectNavigation from "./workbench-project-navigation";
import { useWorkbenchNavigate, useWorkbenchProjectNavigation, type WorkbenchNavigateOptions } from "./use-workbench-project-navigation";
import {
  readWorkbenchLaunchSelection,
  WORKBENCH_LAST_PROJECT_SELECTION_SCHEMA_VERSION,
} from "workbench-shared/state/workbench-client-state";
import { LogicalProjectIdSchema, type LogicalProjectId } from "workbench-shared/workbench/identity";

const emptySubscribe = (_listener: () => void) => () => {};

export function canCanonicalizeWorkbenchRoute(pathname: string, stateSchemaVersion: number) {
  return pathname !== "/launch" || stateSchemaVersion > 0;
}

export function useWorkbenchRoute(client: WorkbenchClientController) {
  const state = useWorkbenchClientStateController();
  const stateSnapshot = useWorkbenchClientStateSnapshot();
  const href = useWorkbenchProjectNavigation(client);
  const navigateToRoute = useWorkbenchNavigate(client);
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

  useEffect(() => {
    // Prefer the catalogue once available, including when an old junction URL
    // was opened directly. Never replace newer user navigation.
    if (!client.controls || `${window.location.pathname}${window.location.search}` !== locationSnapshot) return;
    if (!canCanonicalizeWorkbenchRoute(pathname, stateSnapshot.schemaVersion)) return;
    if (pathname === "/launch") {
      navigateToRoute(route, { replace: true });
      return;
    }
    // A replacement swaps the url's active tab for its canonical spelling in place.
    const canonical = href(route, { replace: true });
    if (!canonical) return;
    const canonicalPath = new URL(canonical, window.location.origin).pathname;
    // The tab list in the path owns the tabs an old query carried.
    const params = new URLSearchParams(window.location.search);
    const legacyTabParams = Object.values(LEGACY_TAB_SEARCH_PARAMS);
    const hadLegacyTabs = legacyTabParams.some(name => params.has(name));
    for (const name of legacyTabParams) params.delete(name);
    if (pathname !== "/" && pathname !== "/@/" && (canonicalPath !== pathname || hadLegacyTabs)) {
      window.history.replaceState({ workbench: true }, "", `${canonicalPath}${params.size ? `?${params}` : ""}${window.location.hash}`);
    }
  }, [pathname, locationSnapshot, client.controls, href, navigateToRoute, route, stateSnapshot.schemaVersion]);

  const selectedProjectIdsKey = route.selectedProjectIds === null
    ? "unfiltered"
    : ["explicit", ...route.selectedProjectIds].join("\0");
  const canSaveSelection = stateSnapshot.schemaVersion >= WORKBENCH_LAST_PROJECT_SELECTION_SCHEMA_VERSION
    && route.view !== "invalid" && (!route.selectedProjectIds?.length || Boolean(route.logical));
  useEffect(() => {
    if (!canSaveSelection) return;
    // Another tab's saved launch preference is not a navigation intent in this tab.
    const storedSelection = state.getSnapshot().records.find(record => record.kind === "lastProjectSelection");
    const storedSelectionKey = storedSelection?.selectedProjectIds === null
      ? "unfiltered"
      : storedSelection ? ["explicit", ...storedSelection.selectedProjectIds].join("\0") : "absent";
    if (selectedProjectIdsKey === storedSelectionKey) return;
    let selectedProjectIds: LogicalProjectId[] | null = null;
    if (selectedProjectIdsKey !== "unfiltered") {
      selectedProjectIds = [];
      for (const projectId of selectedProjectIdsKey.split("\0").slice(1)) {
        const parsed = LogicalProjectIdSchema.safeParse(projectId);
        if (!parsed.success) return;
        selectedProjectIds.push(parsed.data);
      }
    }
    void state.put({ kind: "lastProjectSelection", selectedProjectIds }).catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown app-state mutation failure.";
      console.warn("Workbench last project selection could not be saved.", message.slice(0, 500));
    });
  }, [canSaveSelection, selectedProjectIdsKey, state]);

  return {
    navigateToRoute,
    navigationState,
    route,
  };
}

export function useWorkbenchRouteIntent(
  client: WorkbenchClientController,
  intent: WorkbenchRoute,
  navigateToRoute: (route: WorkbenchRoute, options?: WorkbenchNavigateOptions) => void,
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
