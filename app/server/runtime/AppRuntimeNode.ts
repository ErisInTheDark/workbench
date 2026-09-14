/*
 * Default export:
 * - AppRuntimeNode: own reload dirt and reload execution above every replaceable app feature.
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
      getSourceState: build.getSourceState,
      repositoryRootPath: context.repositoryRootPath,
    }, state?.dirt);
    const reload = new WorkbenchAppReloadController({
      dirt,
      execute: context.executeReloadScopes,
      processScope: "client:process",
    }, state?.reload);
    let detached = false;
    const detach = () => {
      detached = true;
      return { dirt: dirt.detachForReload(), reload: reload.detachForReload() } satisfies AppRuntimeNodeState;
    };
    return {
      beginHandoff: () => ({
        waitForIdle: async () => {},
        expire: () => {},
        detach,
        resume: () => {
          dirt.resumeAfterFailedReload();
          reload.resumeAfterFailedReload();
          detached = false;
        },
        commit: () => { reload.dispose(); },
      }),
      detachForReload: detach,
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
    "app/server/runtime/AppRuntimeNode.ts",
    "app/server/runtime/WorkbenchAppReloadController.ts",
    "app/server/runtime/WorkbenchAppReloadDirtController.ts",
    "shared/reload/ReloadDirtController.ts",
    "shared/reload/ReloadDirtSnapshotRepository.ts",
  ].join("\n"),
});
