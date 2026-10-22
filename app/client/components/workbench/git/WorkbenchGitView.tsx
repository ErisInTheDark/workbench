/* Exports: default WorkbenchGitView: one git tab: its own folder's working tree, commit or stash, bound to that folder's daemon. */
"use client";
import { useMemo } from "react";
import { WorkbenchGitTarget } from "workbench-shared/workbench/navigation/git-route-target";
import { createGitObjectRoute, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchNavigate } from "../../../workbench/navigation/use-workbench-project-navigation";
import { useWorkbenchClientController } from "../workbench-client-context";
import { WorkbenchDaemonAssetOriginContext, WorkbenchOperationsContext } from "../WorkbenchWorkspaceContext";
import WorkbenchGitObjectView from "./WorkbenchGitObjectView";
import WorkbenchWorkingTreeProvider from "./WorkbenchWorkingTreeProvider";
import WorkbenchWorkingTreeView from "./WorkbenchWorkingTreeView";

export default function WorkbenchGitView({ route }: { route: WorkbenchRoute }) {
  const client = useWorkbenchClientController();
  const navigate = useWorkbenchNavigate();
  const mounted = client.mounted;
  const location = mounted?.projectNavigator.gitLocationFor(route) ?? null;
  const daemon = useMemo(() => location ? mounted?.workspace.daemon({ kind: "folder", location }) ?? null : null,
    [location?.daemonId, location?.projectId, mounted]);
  const assets = useMemo(() => location ? { kind: "source" as const, daemonId: location.daemonId } : { kind: "unavailable" as const },
    [location?.daemonId]);
  if (!location || !daemon) return <p className="m-0 py-8 text-center text-fg/muted">Choose a folder</p>;
  const target = route.gitTarget;
  const object = target?.object ?? WorkbenchGitTarget.changes;
  const path = target?.path ?? null;
  return <WorkbenchOperationsContext.Provider value={daemon}>
    <WorkbenchDaemonAssetOriginContext.Provider value={assets}>
      <WorkbenchWorkingTreeProvider projectId={location.projectId} sourceDaemon={daemon} sourceDaemonId={location.daemonId}>
        {object.kind === "changes"
          ? <WorkbenchWorkingTreeView key={`${location.daemonId}/${location.projectId}`} path={path} />
          : <WorkbenchGitObjectView key={`${location.daemonId}/${location.projectId}/${object.sha}`} object={object} path={path}
            onPath={next => navigate(createGitObjectRoute(route, object, next), { replace: true })}
            onLeave={() => navigate(createGitObjectRoute(route, WorkbenchGitTarget.changes), { replace: true })} />}
      </WorkbenchWorkingTreeProvider>
    </WorkbenchDaemonAssetOriginContext.Provider>
  </WorkbenchOperationsContext.Provider>;
}
