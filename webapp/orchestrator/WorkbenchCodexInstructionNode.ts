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
    "webapp/orchestrator/WorkbenchCodexInstructionNode.ts",
    "webapp/orchestrator/WorkbenchCodexInstructionAdapter.ts",
    "webapp/orchestrator/workbench-codex-mcp-config.ts",
    "webapp/orchestrator/workbench-prompt-context.ts",
    "webapp/lib/workbench/instructions/**",
    "!webapp/lib/workbench/instructions/**/*.md",
  ].join("\n"),
});
