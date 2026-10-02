/*
 * Exports:
 * - default WorkbenchCodexInstructionNode: own Codex instruction adaptation and replace its bridge dependant without restarting the app-server.
 */
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexBridgeNode from "./CodexBridgeNode";
import ReloadableNode from "./ReloadableNode";
import WorkbenchCodexInstructionAdapter from "./WorkbenchCodexInstructionAdapter";
import WorkbenchServerSettings from "./lib/workbench/settings/WorkbenchServerSettings";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [CodexBridgeNode],
  create: (context, build) => {
    const settings = new WorkbenchServerSettings(build.get("database"));
    const codexInstructions = new WorkbenchCodexInstructionAdapter(
      context.webSocketUrl,
      context.legacyMigrationProjectRoot,
      () => settings.readLocalCapabilities(),
      () => build.run("mcp", mcp => mcp.listInstructionTools(), "Codex instruction tool catalogue"),
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
  requires: ["database"],
  safeAll: true,
  scope: "server:codex/instructions",
});
