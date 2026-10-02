/*
 * Exports:
 * - default CodexProvider: bind graph-owned Codex capabilities to the daemon provider contract.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexSingleFileController from "./CodexSingleFileController";
import createCodexSingleFileRuntime from "./CodexSingleFileRuntime";
import path from "node:path";

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
  access: "agent",
  children: [],
  create: (context, { get }) => {
    const singleFile = new CodexSingleFileController(createCodexSingleFileRuntime({
      documentsDirectory: path.resolve(context.daemonPackageRoot, "../.workbench/voice-sessions"),
    }));
    const local = get("codexConfiguration");
    const threads = get("codexThreadOperations");
    const configuration = get("codexNativeConfiguration");
    const network = get("codexSandboxNetwork");
    const readNetwork = async (projectId: string | null) => ({
      ...await network.read(projectId), label: "Codex sandbox network access",
    });
    return {
      registrations: { codexProvider: {
        singleFile,
        threads,
        context: threads.context,
        tools: get("codexTools"),
        recovery: get("codexRecovery"),
        browse: threads.browse,
        interactions: threads.interactions,
        configuration: {
          sandboxNetwork: {
            read: readNetwork,
            update: async input => {
              if (input.scope === "global") {
                await network.setGlobal(input.enabled);
              } else {
                await network.setProjectOverride(input.projectId, input.enabled);
              }
              return readNetwork(input.projectId ?? null);
            },
          },
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
      hasPendingWork: () => singleFile.hasPendingWork(),
      dispose: () => singleFile.dispose(),
    };
  },
  description: "Reload the Codex provider definition.",
  lifecycle: "atomic",
  provides: ["codexProvider"],
  requires: ["codexConfiguration", "codexSandboxNetwork", "codexThreadOperations", "codexNativeConfiguration", "codexTools", "codexRecovery"],
  safeAll: true,
  scope: "server:codex/def",
});
