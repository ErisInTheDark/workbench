/*
 * Exports:
 * - default WorkbenchCodexInstructionNode: own Codex instruction adaptation and replace its bridge dependant without restarting the app-server. Keywords: Codex, instructions, MCP, reload.
 */
import type { OrchestratorProcessContext } from "./orchestrator-process-context";
import type { OrchestratorProviderNotification, OrchestratorRuntimeObjects } from "./orchestrator-runtime-objects";
import CodexBridgeNode from "./CodexBridgeNode";
import ReloadableNode from "./ReloadableNode";
import WorkbenchCodexInstructionAdapter from "./WorkbenchCodexInstructionAdapter";

export default new ReloadableNode<OrchestratorProcessContext, OrchestratorRuntimeObjects, OrchestratorProviderNotification>({
  access: "agent",
  children: [CodexBridgeNode],
  create: (context) => {
    const codexInstructions = new WorkbenchCodexInstructionAdapter(
      context.codexBridgeUrl,
      context.legacyMigrationProjectRoot,
    );
    return {
      dispose: () => undefined,
      registrations: { codexInstructions },
      start: () => undefined,
    };
  },
  description: "Reload Codex instruction adaptation and its bridge dependant.",
  lifecycle: "atomic",
  provides: ["codexInstructions"],
  requires: [],
  safeAll: true,
  scope: "server:codex/instructions",
  sources: [
    "daemon/orchestrator/WorkbenchCodexInstructionNode.ts",
    "daemon/orchestrator/WorkbenchCodexInstructionAdapter.ts",
    "daemon/orchestrator/workbench-codex-mcp-config.ts",
    "daemon/orchestrator/workbench-prompt-context.ts",
    "daemon/lib/workbench/instructions/**",
  ].join("\n"),
});
