/*
 * Exports:
 * - useWorkbenchProjectNavigation: bind public href generation to existing catalogue and alias owners.
 */
import { useCallback, useContext, useMemo } from "react";
import WorkbenchClientContext, { type WorkbenchClientController } from "../../components/workbench/workbench-client-context";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../../components/workbench/workbench-client-state-context";
import { parseWorkbenchRouteFromPath, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import { usePathname, useSearchParams } from "./browser-navigation";
import WorkbenchProjectNavigation from "./workbench-project-navigation";

const emptyProjects: readonly WorkbenchProjectOption[] = [];

export function useWorkbenchProjectNavigation(explicitClient?: WorkbenchClientController) {
  const context = useContext(WorkbenchClientContext);
  const projects = (explicitClient ?? context)?.explorer.projects ?? emptyProjects;
  const state = useWorkbenchClientStateController();
  useWorkbenchClientStateSnapshot();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const current = useMemo(() => parseWorkbenchRouteFromPath(pathname, search), [pathname, search]);
  return useCallback((route: WorkbenchRoute) => (
    new WorkbenchProjectNavigation(projects, state.getProjectAliases()).href(route, current)
  ), [projects, state, current]);
}
