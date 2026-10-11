/*
 * Exports:
 * - useWorkbenchProjectNavigation: bind public href generation to the mounted project navigator, re-rendering when its addresses change.
 */
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import WorkbenchClientContext, { type WorkbenchClientController } from "../../components/workbench/workbench-client-context";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../../components/workbench/workbench-client-state-context";
import { parseWorkbenchRouteFromPath, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { usePathname, useSearchParams } from "./browser-navigation";
import WorkbenchProjectNavigation from "./workbench-project-navigation";

const NO_REVISION = () => 0;
const EMPTY_SUBSCRIBE = (_listener: () => void) => () => {};

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
  return useCallback((route: WorkbenchRoute, selection: "inherit" | "exact" = "inherit") => (
    navigation.href(route, current, selection)
  ), [navigation, current, revision]);
}
