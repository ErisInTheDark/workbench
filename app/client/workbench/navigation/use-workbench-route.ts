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
import type { WorkbenchLogicalProject } from "workbench-shared/types";
import { isWorkbenchOpenableFile } from "workbench-shared/workbench/project/tree-utils";
import { createInvalidWorkbenchRoute, isSameWorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";

const emptyLogicalProjects: readonly WorkbenchLogicalProject[] = [];
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
  const launchProjectId = stateSnapshot.records.find(record => record.kind === "lastLaunchTarget")?.projectId;
  const resolved = new WorkbenchProjectNavigation(
    client.explorer.projects, state.getProjectAliases(), client.explorer.logicalProjects ?? emptyLogicalProjects,
  )
    .readRoute(locationSnapshot, launchProjectId);
  const route = useMemo(() => resolved, [
    locationSnapshot, resolved.projectId, resolved.threadOwnerProjectId,
    resolved.logical?.projectId, resolved.logical?.threadOwnerProjectId,
    resolved.view, resolved.error, pathname === "/launch" ? launchProjectId : undefined,
  ]);

  const navigateToRoute = useCallback((nextRoute: WorkbenchRoute, options: { replace?: boolean } = {}) => {
    const nextHref = href(nextRoute);
    if (nextHref === undefined || nextHref === locationSnapshot) {
      return;
    }

    if (options.replace) {
      window.history.replaceState({ workbench: true }, "", nextHref);
    } else {
      window.history.pushState({ workbench: true }, "", nextHref);
    }
  }, [href, locationSnapshot]);

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
    if (canonicalPath !== pathname) {
      window.history.replaceState({ workbench: true }, "", `${canonicalPath}${window.location.search}${window.location.hash}`);
    }
  }, [pathname, locationSnapshot, client.controls, client.explorer.projects, client.explorer.logicalProjects, href, navigateToRoute, route]);

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
  const lastApplied = useRef<{
    controls: NonNullable<WorkbenchClientController["controls"]>;
    route: WorkbenchRoute;
  } | null>(null);
  navigate.current = navigateToRoute;
  const logicalReady = !intent.logical || Boolean(
    client.mounted?.presentationClient?.snapshot().data && client.explorer.logicalProjects,
  );
  useEffect(() => {
    const controls = client.controls;
    if (!controls) return;
    if (!logicalReady) return;
    const requested = intent.view === "file" && !isWorkbenchOpenableFile(intent.filePath)
      ? createInvalidWorkbenchRoute(`This file cannot be opened here: ${intent.filePath}`)
      : intent;
    const prior = lastApplied.current;
    if (prior?.controls === controls && isSameWorkbenchRoute(prior.route, requested)) return;
    const applied = { controls, route: requested };
    lastApplied.current = applied;
    let active = true;
    void controls.applyRoute(requested).then(result => {
      if (active && !result.ok && result.error && lastApplied.current === applied) lastApplied.current = null;
      if (active && result.canonicalRoute) navigate.current(result.canonicalRoute, { replace: true });
    }).catch(error => {
      if (active && lastApplied.current === applied) lastApplied.current = null;
      if (active) console.error("Workbench route could not open:",
        error instanceof Error ? error.message.slice(0, 512) : "Unknown route failure.");
    });
    return () => {
      active = false;
      if (lastApplied.current === applied) lastApplied.current = null;
    };
  }, [client.controls, client.mounted, logicalReady, intent]);
}
