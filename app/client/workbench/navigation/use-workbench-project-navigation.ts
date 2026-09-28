/*
 * Exports:
 * - useWorkbenchProjectNavigation: bind public href generation to existing catalogue and alias owners.
 */
import { useCallback, useContext, useMemo } from "react";
import WorkbenchClientContext, { type WorkbenchClientController } from "../../components/workbench/workbench-client-context";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../../components/workbench/workbench-client-state-context";
import { parseWorkbenchRouteFromPath, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { usePathname, useSearchParams } from "./browser-navigation";
import WorkbenchProjectNavigation from "./workbench-project-navigation";

const emptyProjects: readonly WorkbenchProjectOption[] = [];
const emptyLogicalProjects: readonly WorkbenchLogicalProject[] = [];

export function useWorkbenchProjectNavigation(explicitClient?: WorkbenchClientController) {
  const context = useContext(WorkbenchClientContext);
  const client = explicitClient ?? context;
  const projects = client?.explorer.projects ?? emptyProjects;
  const logicalProjects = client?.explorer.logicalProjects ?? emptyLogicalProjects;
  const state = useWorkbenchClientStateController();
  useWorkbenchClientStateSnapshot();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const current = useMemo(() => parseWorkbenchRouteFromPath(pathname, search), [pathname, search]);
  return useCallback((route: WorkbenchRoute, selection: "inherit" | "exact" = "inherit") => (
    new WorkbenchProjectNavigation(projects, state.getProjectAliases(), logicalProjects,
      threadId => {
        const owner = client?.mounted?.threadOwnerFor(threadId);
        return owner ? { daemonId: owner.daemonId, projectId: ProjectIdSchema.parse(owner.projectId) } : null;
      }).href(route, current, selection)
  ), [client?.mounted, logicalProjects, projects, state, current]);
}
