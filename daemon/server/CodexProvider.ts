/*
 * Exports:
 * - default CodexProvider: bind graph-owned Codex capabilities to the daemon provider contract.
 */
import ReloadableNode from "./ReloadableNode";
import type { DaemonProcessContext } from "./daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "./daemon-runtime-objects";
import CodexSingleFileController from "./CodexSingleFileController";
import createCodexSingleFileRuntime from "./CodexSingleFileRuntime";
import WorkbenchVoiceNode from "./WorkbenchVoiceNode";
import path from "node:path";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [WorkbenchVoiceNode],
  create: (context, { get }) => {
    const singleFile = new CodexSingleFileController(createCodexSingleFileRuntime(
      path.resolve(context.daemonPackageRoot, "../.workbench/voice-sessions"),
    ));
    const local = get("codexConfiguration");
    const threads = get("codexThreadOperations");
    const configuration = get("codexNativeConfiguration");
    const network = get("codexSandboxNetwork");
    const readNetwork = async (projectId: string) => ({
      ...await network.read(projectId), label: "Codex sandbox network access",
    });
    return {
      registrations: { codexProvider: {
        singleFile,
        threads,
        tools: get("codexTools"),
        recovery: get("codexRecovery"),
        browse: threads.browse,
        interactions: threads.interactions,
        configuration: {
          sandboxNetwork: {
            read: readNetwork,
            update: async input => {
              if (input.scope === "global") {
                if (input.enabled === null) throw new Error("Global sandbox network access requires a boolean.");
                await network.setGlobal(input.enabled);
              } else {
                await network.setProjectOverride(input.projectId, input.enabled);
              }
              return readNetwork(input.projectId);
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
      dispose: () => singleFile.dispose(),
    };
  },
  description: "Reload the Codex provider definition.",
  lifecycle: "atomic",
  provides: ["codexProvider"],
  requires: ["codexConfiguration", "codexSandboxNetwork", "codexThreadOperations", "codexNativeConfiguration", "codexTools", "codexRecovery"],
  safeAll: true,
  scope: "server:codex/def",
  sources: [
    "daemon/server/CodexProvider.ts",
    "daemon/server/CodexSingleFileController.ts",
    "daemon/server/CodexSingleFileRuntime.ts",
    "daemon/server/CodexSingleFileDocuments.ts",
    "shared/workbench/provider/provider-single-file.ts",
  ].join("\n"),
});
