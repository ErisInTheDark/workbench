/*
 * Exports:
 * - default ClaudeProviderNode: expose native Claude sessions, managed tools, and model choices.
 */
import ReloadableNode from "../../ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import CodexShellController from "../../CodexShellController";
import ClaudeToolsController from "./ClaudeToolsController";

const models = ["sonnet", "opus", "haiku"].map(id => ({
  id, displayName: id[0]!.toUpperCase() + id.slice(1),
  description: "Claude Code model alias", hidden: false, isDefault: id === "sonnet",
  supportsPersonality: false, supportsReasoningEffort: false,
  supportedReasoningEfforts: [], defaultReasoningEffort: null,
  supportsVision: true, supportsFastMode: false,
  inputModalities: ["text", "image"], maxContextWindowTokens: null,
  contextWindow: null, additionalSpeedTiers: [], policyState: null, billingMultiplier: null,
}));

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
    return {
      registrations: {
        claudeProvider: {
          threads, tools, interactions: threads.interactions, context: threads.context,
          configuration: {
            modelContext: { read: async () => [] },
            models: { read: async () => models },
            guidance: { contains: async sections => sections.map(() => false) },
          },
        },
      },
      start: () => undefined,
      dispose: () => undefined,
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
    "daemon/server/providers/claude/ClaudeToolsController.ts",
    "daemon/server/CodexShellController.ts",
    "daemon/server/WorkbenchApprovedCommandExecutor.ts",
    "shared/workbench/provider/provider-registrations.ts",
  ].join("\n"),
});
