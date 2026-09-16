/*
 * Exports:
 * - default WorkbenchTurnLifecycleNode: own reloadable turn recovery and Codex MCP generation above their core and bridge dependants.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import { recoverCodexTurn } from "./codex-turn-recovery";
import ReloadableNode from "./ReloadableNode";
import CodexBridgeNode from "./CodexBridgeNode";
import WorkbenchCodexMcpGenerationController, { type WorkbenchCodexMcpGenerationState } from "./WorkbenchCodexMcpGenerationController";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchWebSocketNode from "./WorkbenchWebSocketNode";
import WorkbenchDaemonReloadController, { type WorkbenchDaemonReloadControllerState } from "./WorkbenchDaemonReloadController";
import WorkbenchReloadDirtController, { type WorkbenchReloadDirtControllerState } from "./WorkbenchReloadDirtController";
import WorkbenchTurnRecoveryController, { type WorkbenchTurnRecoveryControllerState } from "./WorkbenchTurnRecoveryController";

interface WorkbenchTurnLifecycleState {
  reloadController?: WorkbenchDaemonReloadControllerState;
  reloadDirt?: WorkbenchReloadDirtControllerState;
  mcpGeneration: WorkbenchCodexMcpGenerationState;
  turnRecovery: WorkbenchTurnRecoveryControllerState;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [WorkbenchCoreNode, WorkbenchAgentCommandNode, WorkbenchMcpNode, CodexBridgeNode, WorkbenchWebSocketNode],
  create: (context, build) => {
    const state = build.handoffState as WorkbenchTurnLifecycleState | undefined;
    const codexMcpGeneration = new WorkbenchCodexMcpGenerationController(state?.mcpGeneration);
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
      async (candidate) => {
        const cwd = typeof record(candidate.request.params)?.cwd === "string" ? String(record(candidate.request.params)!.cwd).trim() : "";
        if (!cwd) {
          context.logTurnRecovery(`Recovery failure for ${candidate.harness}:${candidate.threadId} has no cwd for lifecycle publication.`);
          return;
        }
        await context.reportTurnRecoveryFailure(cwd, candidate.harness, candidate.threadId);
      },
      state?.turnRecovery,
      {
        codex: async (candidate, signal) => await recoverCodexTurn(candidate, {
          request: async (request) => {
            signal?.throwIfAborted();
            if (request.method === "turn/start") turnRecovery.observeRequest("codex", request);
            if (request.method === "workbench/codex/message/admit") {
              const startRequest = record(record(request.params)?.startRequest);
              if (startRequest?.method === "turn/start") turnRecovery.observeRequest("codex", startRequest as import("./bridge-types").JsonRpcRequest);
            }
            const response = await context.harnessPorts.codex.request(request, signal);
            signal?.throwIfAborted();
            return response;
          },
        }),
      },
      async (label, task) => await context.runTurnRecoveryTask(turnRecovery, label, task),
    );
    let detached = false;
    const drain = async () => {
      turnRecovery.beginRuntimeDrain();
      const turnRecoveryState = await turnRecovery.detachForReload();
      return {
        mcpGeneration: codexMcpGeneration.detachForReload(),
        reloadController: reloadController.detachForReload(),
        reloadDirt: reloadDirt.detachForReload(),
        turnRecovery: turnRecoveryState,
      } satisfies WorkbenchTurnLifecycleState;
    };
    return {
      beginHandoff: () => ({
        waitForIdle: async () => {
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
      dispose: async () => { if (!detached) await drain(); },
      listRuntimeDrainPending: () => turnRecovery.listRuntimeDrainPending(),
      registrations: { codexMcpGeneration, reloadController, reloadDirt, turnRecovery },
      start: async () => {
        await reloadDirt.start();
      },
    };
  },
  description: "Reload managed turn recovery and MCP freshness with their core and bridge dependants.",
  lifecycle: "handoff",
  provides: ["codexMcpGeneration", "reloadController", "reloadDirt", "turnRecovery"],
  requires: [],
  safeAll: true,
  scope: "server:turns",
  sources: [
    "daemon/server/WorkbenchTurnLifecycleNode.ts",
    "daemon/server/WorkbenchTurnRecoveryController.ts",
    "daemon/server/WorkbenchCodexMcpGenerationController.ts",
    "daemon/server/codex-turn-recovery.ts",
    "daemon/server/WorkbenchTurnRecovery*.test.ts",
    "daemon/server/WorkbenchCodexMcpGenerationController.test.ts",
    "daemon/server/codex-turn-recovery.test.ts",
  ].join("\n"),
});
