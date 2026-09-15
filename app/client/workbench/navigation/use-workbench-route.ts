/*
 * Exports:
 * - useWorkbenchRoute: React hook that derives workbench route state from browser history and exposes guarded user navigation. Keywords: URL source of truth, browser history, pathname, search params.
 */

import { useCallback, useEffect, useMemo } from "react";

import { usePathname, useSearchParams } from "./browser-navigation";
import {
  type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchClientController } from "../../components/workbench/workbench-client-context";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../../components/workbench/workbench-client-state-context";
import WorkbenchProjectNavigation from "./workbench-project-navigation";
import { useWorkbenchProjectNavigation } from "./use-workbench-project-navigation";

export function useWorkbenchRoute(client: WorkbenchClientController) {
  const state = useWorkbenchClientStateController();
  const stateSnapshot = useWorkbenchClientStateSnapshot();
  const href = useWorkbenchProjectNavigation(client);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const locationSnapshot = useMemo(
    () => `${pathname || "/"}${search ? `?${search}` : ""}`,
    [pathname, search],
  );
  const launchProjectId = stateSnapshot.records.find(record => record.kind === "lastLaunchTarget")?.projectId;
  const resolved = new WorkbenchProjectNavigation(client.explorer.projects, state.getProjectAliases())
    .readRoute(locationSnapshot, launchProjectId);
  const route = useMemo(() => resolved, [
    locationSnapshot, resolved.projectId, resolved.threadOwnerProjectId, pathname === "/launch" ? launchProjectId : undefined,
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
    // Launch intent needs catalogue addresses. Never replace a location the user
    // reached while the initial project observation was opening.
    if (pathname !== "/launch" || !client.controls || window.location.pathname !== "/launch") return;
    navigateToRoute(route, { replace: true });
  }, [pathname, client.controls, navigateToRoute, route]);

  return {
    navigateToRoute,
    route,
  };
}
