/*
 * Exports:
 * - default CodexProvider: bind graph-owned Codex capabilities to the daemon provider contract.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [],
  create: (_context, { get }) => {
    const local = get("codexConfiguration");
    const threads = get("codexThreadOperations");
    const configuration = get("codexNativeConfiguration");
    return {
      registrations: { codexProvider: {
        threads,
        interactions: threads.interactions,
        configuration: {
          modelContext: local,
          models: { read: () => configuration.models(() => local.read()) },
          guidance: { contains: sections => local.containsGlobalGuidance(sections) },
        },
        account: { limits: { read: () => configuration.accountLimits() } },
        goals: {
          read: threadId => threads.readGoal(threadId),
          update: input => threads.updateGoal(input),
          clear: threadId => threads.clearGoal(threadId),
        },
      } },
      start: () => undefined,
      dispose: () => undefined,
    };
  },
  description: "Reload the Codex provider definition.",
  lifecycle: "atomic",
  provides: ["codexProvider"],
  requires: ["codexConfiguration", "codexThreadOperations", "codexNativeConfiguration"],
  safeAll: true,
  scope: "server:codex/def",
  sources: "daemon/server/CodexProvider.ts",
});
