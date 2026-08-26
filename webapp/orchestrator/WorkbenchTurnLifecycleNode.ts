/*
 * Exports:
 * - default WorkbenchTurnLifecycleNode: own reloadable turn recovery and Codex MCP generation above their core and bridge dependants. Keywords: turn, recovery, MCP, graph, handoff.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import { recoverCodexTurn } from "./codex-turn-recovery";
import ReloadableNode from "./ReloadableNode";
import CodexBridgeNode from "./CodexBridgeNode";
import OpenCodeBridgeNode from "./OpenCodeBridgeNode";
import WorkbenchCodexMcpGenerationController, { type WorkbenchCodexMcpGenerationState } from "./WorkbenchCodexMcpGenerationController";
import WorkbenchCoreNode from "./WorkbenchCoreNode";
import WorkbenchAgentCommandNode from "./WorkbenchAgentCommandNode";
import WorkbenchMcpNode from "./WorkbenchMcpNode";
import WorkbenchOrchestratorReloadController, { type WorkbenchOrchestratorReloadControllerState } from "./WorkbenchOrchestratorReloadController";
import WorkbenchReloadDirtController, { type WorkbenchReloadDirtControllerState } from "./WorkbenchReloadDirtController";
import WorkbenchTurnRecoveryController, { type WorkbenchTurnRecoveryControllerState } from "./WorkbenchTurnRecoveryController";
import WorkbenchTurnRecoveryHandoffStore from "./WorkbenchTurnRecoveryHandoffStore";
import {
  activateReloadNodeSourceState,
  cancelReloadNodeSourceState,
  readReloadNodeSourceState,
} from "./reload-node-source-map";

interface WorkbenchTurnLifecycleState {
  reloadController?: WorkbenchOrchestratorReloadControllerState;
  reloadDirt?: WorkbenchReloadDirtControllerState;
  mcpGeneration: WorkbenchCodexMcpGenerationState;
  turnRecovery: WorkbenchTurnRecoveryControllerState;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [WorkbenchCoreNode, WorkbenchAgentCommandNode, WorkbenchMcpNode, CodexBridgeNode, OpenCodeBridgeNode],
  create: (context, build) => {
    const state = build.handoffState as WorkbenchTurnLifecycleState | undefined;
    const codexMcpGeneration = new WorkbenchCodexMcpGenerationController(state?.mcpGeneration);
    const reloadDirt = new WorkbenchReloadDirtController({
      activateSourceState: activateReloadNodeSourceState,
      cancelSourceState: cancelReloadNodeSourceState,
      getSourceState: readReloadNodeSourceState,
      repoRoot: context.legacyMigrationProjectRoot,
    }, state?.reloadDirt);
    const reloadController = new WorkbenchOrchestratorReloadController({
      dirt: reloadDirt,
      executeBatch: context.executeReloadScopes,
      hardReload: context.hardReload,
      initialState: state?.reloadController,
    });
    const recoverOpenCodeTurn = context.harnessPorts.opencode.recoverInterruptedTurn;
    if (!recoverOpenCodeTurn) throw new Error("OpenCode is missing its declared turn-recovery port.");
    let turnRecovery!: WorkbenchTurnRecoveryController;
    const prepareCodexMcp = async () => {
      await codexMcpGeneration.prepare(null, async () => {
        const response = await context.harnessPorts.codex.request({
          id: `workbench:mcp-refresh:${codexMcpGeneration.generation}`,
          method: "config/mcpServer/reload",
          params: null,
        });
        if (response.error) throw new Error(response.error.message);
      });
    };
    turnRecovery = new WorkbenchTurnRecoveryController(
      new WorkbenchTurnRecoveryHandoffStore(context.legacyMigrationProjectRoot),
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
        codex: async (candidate) => await recoverCodexTurn(candidate, {
          prepareMcp: prepareCodexMcp,
          request: async (request) => {
            if (request.method === "turn/start") turnRecovery.observeRequest("codex", request);
            return await context.harnessPorts.codex.request(request);
          },
        }),
        opencode: recoverOpenCodeTurn,
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
      beginRuntimeDrain: () => { turnRecovery.beginRuntimeDrain(); },
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
        await turnRecovery.loadPersistedHandoff();
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
    "webapp/orchestrator/WorkbenchTurnLifecycleNode.ts",
    "webapp/orchestrator/WorkbenchTurnRecoveryController.ts",
    "webapp/orchestrator/WorkbenchTurnRecoveryHandoffStore.ts",
    "webapp/orchestrator/WorkbenchCodexMcpGenerationController.ts",
    "webapp/orchestrator/codex-turn-recovery.ts",
    "webapp/orchestrator/workbench-turn-recovery-*.test.ts",
    "webapp/orchestrator/workbench-codex-mcp-generation-controller.test.ts",
    "webapp/orchestrator/codex-turn-recovery.test.ts",
  ].join("\n"),
});
