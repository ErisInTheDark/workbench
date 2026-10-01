/*
 * Exports:
 * - default ClaudeProviderNode: expose native Claude sessions, managed tools, and model choices.
 */
import ReloadableNode from "../../ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import CodexShellController from "../../CodexShellController";
import ClaudeToolsController from "./ClaudeToolsController";
import ClaudeConfigurationController from "./ClaudeConfigurationController";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (_context, { get }) => {
    const threads = get("claudeThreadOperations");
    const shell = new CodexShellController({
      executor: get("codexExecutor"),
      readConfiguration: cwd => get("codexThreadOperations").requestNative("config/read", { cwd, includeLayers: false }),
    });
    const tools = new ClaudeToolsController({
      threads, transcript: get("claudeTranscriptAdapter"),
      execute: shell.executeAdmitted.bind(shell),
    });
    const configuration = new ClaudeConfigurationController();
    return {
      registrations: {
        claudeProvider: {
          threads, tools, interactions: threads.interactions, context: threads.context,
          configuration: {
            modelContext: { read: async () => [] },
            models: { read: () => configuration.models() },
            guidance: { contains: async sections => sections.map(() => false) },
          },
        },
      },
      start: () => undefined,
      dispose: () => configuration.dispose(),
    };
  },
  description: "Reload Claude provider definition.",
  lifecycle: "atomic",
  provides: ["claudeProvider"],
  requires: ["claudeThreadOperations", "claudeTranscriptAdapter", "codexExecutor", "codexThreadOperations"],
  safeAll: true,
  scope: "server:claude/def",
  sources: [
    "daemon/server/providers/claude/ClaudeProviderNode.ts",
    "daemon/server/providers/claude/ClaudeConfigurationController.ts",
    "daemon/server/providers/claude/claude-process-options.ts",
    "daemon/server/providers/claude/ClaudeToolsController.ts",
    "daemon/server/CodexShellController.ts",
    "daemon/server/WorkbenchApprovedCommandExecutor.ts",
    "shared/workbench/provider/provider-registrations.ts",
    "shared/workbench/provider/provider-model.ts",
  ].join("\n"),
});
