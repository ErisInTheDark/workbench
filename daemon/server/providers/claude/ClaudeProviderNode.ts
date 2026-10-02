/*
 * Exports:
 * - default ClaudeProviderNode: expose native Claude sessions, managed tools, Browse screenshot delivery, model choices with context bounds, plan limits, and session-log usage hydration.
 */
import ReloadableNode from "../../ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import CodexShellController from "../../CodexShellController";
import ClaudeToolsController from "./ClaudeToolsController";

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
    const configuration = get("claudeConfiguration");
    return {
      registrations: {
        claudeProvider: {
          threads, tools, interactions: threads.interactions, context: threads.context, browse: threads.browse,
          usage: threads.usage,
          account: { limits: { read: () => configuration.accountLimits() } },
          configuration: {
            modelContext: { read: () => configuration.modelContext() },
            models: { read: () => configuration.models() },
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
  requires: ["claudeConfiguration", "claudeThreadOperations", "claudeTranscriptAdapter", "codexExecutor", "codexThreadOperations"],
  safeAll: true,
  scope: "server:claude/def",
});
