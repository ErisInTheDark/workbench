/*
 * Exports:
 * - default WorkbenchTurnLifecycleNode: own shared recovery and tool catalogue revision above their dependants.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexRecoveryNode from "./CodexRecoveryNode";
import ReloadableNode from "./ReloadableNode";
import CodexBridgeNode from "./CodexBridgeNode";
import WorkbenchToolRevisionController, { type WorkbenchToolRevisionState } from "./WorkbenchToolRevisionController";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchDaemonReloadController, { type WorkbenchDaemonReloadControllerState } from "./WorkbenchDaemonReloadController";
import WorkbenchReloadDirtController, { type WorkbenchReloadDirtControllerState } from "./WorkbenchReloadDirtController";
import WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import OpenCodeBridgeNode from "./providers/opencode/OpenCodeBridgeNode";
import WorkbenchDaemonSleepController from "./WorkbenchDaemonSleepController";

interface WorkbenchTurnLifecycleState {
  reloadController?: WorkbenchDaemonReloadControllerState;
  reloadDirt?: WorkbenchReloadDirtControllerState;
  toolRevision?: WorkbenchToolRevisionState;
  mcpGeneration?: WorkbenchToolRevisionState;
}

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [CodexRecoveryNode, WorkbenchCoreNode, WorkbenchAgentCommandNode, WorkbenchMcpNode, CodexBridgeNode, OpenCodeBridgeNode, WorkbenchWebSocketNode],
  create: (context, build) => {
    const state = build.handoffState as WorkbenchTurnLifecycleState | undefined;
    const daemonSleep = new WorkbenchDaemonSleepController(context.sleep);
    const toolRevision = new WorkbenchToolRevisionController(state?.toolRevision ?? state?.mcpGeneration);
    const reloadDirt = new WorkbenchReloadDirtController({
      getSourceState: build.getSourceState,
      repoRoot: context.legacyMigrationProjectRoot,
    }, state?.reloadDirt);
    const reloadController = new WorkbenchDaemonReloadController({
      dirt: reloadDirt,
      executeBatch: context.executeReloadScopes,
      hardReload: context.hardReload,
      initialState: state?.reloadController,
    });
    let turnRecovery!: WorkbenchTurnRecoveryController;
    turnRecovery = new WorkbenchTurnRecoveryController(
      context.logTurnRecovery,
      async (label, task) => await context.runTurnRecoveryTask(turnRecovery, label, task),
    );
    let detached = false;
    const drain = async () => {
      turnRecovery.beginRuntimeDrain();
      await turnRecovery.waitForIdle();
      return {
        toolRevision: toolRevision.detachForReload(),
        reloadController: reloadController.detachForReload(),
        reloadDirt: reloadDirt.detachForReload(),
      } satisfies WorkbenchTurnLifecycleState;
    };
    return {
      beginHandoff: () => ({
        waitForIdle: async () => {
          await daemonSleep.suspend();
          turnRecovery.beginRuntimeDrain();
          await turnRecovery.waitForIdle();
        },
        expire: () => { turnRecovery.expireRuntimeDrain(); },
        detach: async () => {
          const nextState = await drain();
          detached = true;
          return nextState;
        },
        resume: () => {
          daemonSleep.resume();
          reloadDirt.resumeAfterFailedReload();
          reloadController.resumeAfterFailedReload();
          turnRecovery.resumeAfterFailedReload();
          detached = false;
        },
        commit: () => { turnRecovery.expireRuntimeDrain(); },
      }),
      beginRuntimeDrain: () => { turnRecovery.beginRuntimeDrain(); },
      expireRuntimeDrain: () => { turnRecovery.expireRuntimeDrain(); },
      detachForReload: async () => {
        const nextState = await drain();
        detached = true;
        return nextState;
      },
      dispose: async () => { await daemonSleep.dispose(); if (!detached) await drain(); },
      listRuntimeDrainPending: () => turnRecovery.listRuntimeDrainPending(),
      registrations: { toolRevision, reloadController, reloadDirt, turnRecovery, daemonSleep },
      start: async () => {
        await reloadDirt.start();
        daemonSleep.refresh();
      },
    };
  },
  description: "Reload managed turn recovery and tool catalogue revision with their dependants.",
  lifecycle: "handoff",
  provides: ["toolRevision", "reloadController", "reloadDirt", "turnRecovery", "daemonSleep"],
  requires: [],
  safeAll: true,
  scope: "server:turns",
  sources: [
    "daemon/server/WorkbenchTurnLifecycleNode.ts",
    "shared/reload/ReloadSourceWatcher.ts",
    "daemon/server/WorkbenchTurnRecoveryController.ts",
    "daemon/server/WorkbenchToolRevisionController.ts",
    "daemon/server/WorkbenchTurnRecovery*.test.ts",
    "daemon/server/WorkbenchToolRevisionController.test.ts",
  ].join("\n"),
});
