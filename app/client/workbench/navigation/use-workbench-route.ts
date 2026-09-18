/*
 * Exports:
 * - useWorkbenchRoute: derive routes from browser history and expose guarded canonical navigation.
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
    // Prefer the catalogue once available, including when an old junction URL
    // was opened directly. Never replace newer user navigation.
    if (!client.controls || `${window.location.pathname}${window.location.search}` !== locationSnapshot) return;
    const identities = [route.projectId, route.threadOwnerProjectId].filter(Boolean);
    if (identities.some(id => !client.explorer.projects.some(project => project.id === id))) return;
    if (pathname === "/launch") {
      navigateToRoute(route, { replace: true });
      return;
    }
    if (identities.length === 0) return;
    const canonical = href(route);
    if (!canonical) return;
    const canonicalPath = new URL(canonical, window.location.origin).pathname;
    if (canonicalPath !== pathname) {
      window.history.replaceState({ workbench: true }, "", `${canonicalPath}${window.location.search}${window.location.hash}`);
    }
  }, [pathname, locationSnapshot, client.controls, client.explorer.projects, href, navigateToRoute, route]);

  return {
    navigateToRoute,
    route,
  };
}
