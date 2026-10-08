/*
 * Default export:
 * - AppRuntimeNode: own reload dirt, reload execution and the reload-all/pull orchestrator above every replaceable app feature.
 */
import ReloadableNode from "workbench-shared/reload/ReloadableNode";

import type { AppProcessContext } from "./app-process-context.ts";
import type { AppRuntimeObjects } from "./app-runtime-objects.ts";
import AppDatabaseNode from "./AppDatabaseNode.ts";
import AppTopologyNode from "./AppTopologyNode.ts";
import WorkbenchAppReloadController, { type WorkbenchAppReloadControllerState } from "./WorkbenchAppReloadController.ts";
import WorkbenchAppReloadDirtController, { type WorkbenchAppReloadDirtControllerState } from "./WorkbenchAppReloadDirtController.ts";
import WorkbenchAppReloadOrchestrator, { type WorkbenchAppReloadOrchestratorState } from "./WorkbenchAppReloadOrchestrator";
import {
  pullDaemonInstallation, readDaemonReloadDirt, reloadDaemonScopes, resolveOperationDaemon,
} from "./daemon-reload-operations.ts";

interface AppRuntimeNodeState {
  dirt: WorkbenchAppReloadDirtControllerState;
  reload: WorkbenchAppReloadControllerState;
  orchestration?: WorkbenchAppReloadOrchestratorState;
}

export default ReloadableNode.define<AppProcessContext, AppRuntimeObjects, never>()({
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
      repositoryRootPath: context.repositoryRootPath,
      repairInstall: () => context.runRuntimeObject("network", async network => { await network.stopHostForInstall(); }),
    }, state?.reload);
    const orchestrator = new WorkbenchAppReloadOrchestrator({
      readControlDaemon: context.readControlDaemonFacts,
      isLocalDaemon: context.isLocalDaemon,
      readAppDirt: () => context.readAppRuntimeSnapshot().reloadDirt,
      // Without an attached daemon, reload-all still reloads the app and host.
      readDaemonDirt: (daemonId, signal) => context.runRuntimeObject("sources", async sources =>
        !daemonId && !sources.attached ? null : readDaemonReloadDirt(resolveOperationDaemon(sources, daemonId), signal)),
      pullDaemon: (daemonId, signal) => context.runRuntimeObject("sources", sources =>
        pullDaemonInstallation(resolveOperationDaemon(sources, daemonId), signal)),
      refreshAppDirt: signal => context.runRuntimeObject("reloadDirt", async owner => { await owner.refresh(signal); }),
      reloadDaemon: (scopes, daemonId, signal) => context.runRuntimeObject("sources", sources =>
        reloadDaemonScopes(resolveOperationDaemon(sources, daemonId), scopes, signal)),
      reloadHost: (scopes, signal) => context.runRuntimeObject("network", async network => { await network.reloadHost(scopes, signal); }),
      admitClient: context.admitAppReload,
      warn: message => context.processLogger.error("app", message),
    }, state?.orchestration);
    let detached = false;
    const detach = () => {
      detached = true;
      return { dirt: dirt.detachForReload(), reload: reload.detachForReload(),
        orchestration: orchestrator.detachForReload() } satisfies AppRuntimeNodeState;
    };
    return {
      beginHandoff: () => ({
        waitForIdle: async () => {},
        expire: () => { orchestrator.cancelPending(); },
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
        orchestrator.dispose();
        return dirt.dispose();
      },
      registrations: { reloadController: reload, reloadDirt: dirt, reloadOrchestrator: orchestrator },
      start: () => dirt.start(),
    };
  },
  description: "Reload app source-dirt and reload policy with every dependent app feature.",
  lifecycle: "handoff",
  provides: ["reloadController", "reloadDirt", "reloadOrchestrator"],
  requires: [],
  safeAll: false,
  scope: "client:runtime",
});
