/*
 * Exports:
 * - default WorkbenchCodexInstructionNode: own Codex instruction adaptation and replace its bridge dependant without restarting the app-server.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexBridgeNode from "./CodexBridgeNode";
import ReloadableNode from "./ReloadableNode";
import WorkbenchCodexInstructionAdapter from "./WorkbenchCodexInstructionAdapter";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
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
    "daemon/server/WorkbenchCodexInstructionNode.ts",
    "daemon/server/WorkbenchCodexInstructionAdapter.ts",
    "daemon/server/workbench-codex-mcp-config.ts",
    "daemon/server/workbench-prompt-context.ts",
    "daemon/server/lib/workbench/instructions/**",
  ].join("\n"),
});
