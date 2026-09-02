/*
 * Default export:
 * - AppRuntimeNode: own reload dirt and reload execution above every replaceable app feature. Keywords: app, reload, root, handoff.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppDatabaseNode from "./AppDatabaseNode.ts";
import AppTopologyNode from "./AppTopologyNode.ts";
import WorkbenchAppReloadController, { type WorkbenchAppReloadControllerState } from "./WorkbenchAppReloadController.ts";
import WorkbenchAppReloadDirtController, { type WorkbenchAppReloadDirtControllerState } from "./WorkbenchAppReloadDirtController.ts";

interface AppRuntimeNodeState {
  dirt: WorkbenchAppReloadDirtControllerState;
  reload: WorkbenchAppReloadControllerState;
}

export default new ReloadableNode<AppProcessContext, AppRuntimeObjects, never>({
  access: "operator",
  children: [AppDatabaseNode, AppTopologyNode],
  create: (context, build) => {
    const state = build.handoffState as AppRuntimeNodeState | undefined;
    const dirt = new WorkbenchAppReloadDirtController({
      getCatalog: context.getReloadScopeCatalog,
      getDependantClosure: context.getReloadDependantClosure,
      getScopesForPaths: context.getReloadScopesForPaths,
      repositoryRootPath: context.repositoryRootPath,
    }, state?.dirt);
    const reload = new WorkbenchAppReloadController({
      dirt,
      execute: context.executeReloadScopes,
      processScope: "client:process",
    }, state?.reload);
    let detached = false;
    return {
      detachForReload: () => {
        detached = true;
        return { dirt: dirt.detachForReload(), reload: reload.detachForReload() } satisfies AppRuntimeNodeState;
      },
      dispose: () => {
        if (detached) return;
        reload.dispose();
        return dirt.dispose();
      },
      registrations: { reloadController: reload, reloadDirt: dirt },
      start: () => dirt.start(),
    };
  },
  description: "Reload app source-dirt and reload policy with every dependent app feature.",
  lifecycle: "handoff",
  provides: ["reloadController", "reloadDirt"],
  requires: [],
  safeAll: false,
  scope: "client:runtime",
  sources: [
    "app/runtime/AppRuntimeNode.ts",
    "app/runtime/WorkbenchAppReloadController.ts",
    "app/runtime/WorkbenchAppReloadDirtController.ts",
    "shared/reload/ReloadDirtController.ts",
    "shared/reload/ReloadDirtSnapshotRepository.ts",
  ].join("\n"),
});
