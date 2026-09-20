/*
 * Exports:
 * - default OpenCodeProvider: bind graph-owned OpenCode capabilities to the daemon provider contract.
 */
import ReloadableNode from "../../ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import OpenCodeToolsController from "./OpenCodeToolsController";
import CodexShellController from "../../CodexShellController";

export default new ReloadableNode<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>({
  access: "agent",
  children: [],
  create: (_context, { get }) => {
    const service = get("openCodeService");
    const threads = get("openCodeThreadOperations");
    const shell = new CodexShellController({
      executor: get("codexExecutor"),
      readConfiguration: async () => ({ config: {} }),
    });
    const tools = new OpenCodeToolsController({
      resolveCaller: (nativeThreadId, signal) => threads.resolveToolCaller(nativeThreadId, signal),
      execute: shell.executeAdmitted.bind(shell),
      executeReadOnly: shell.executeReadOnly.bind(shell),
    });
    return {
      registrations: {
        openCodeProvider: {
          threads,
          interactions: threads.interactions,
          tools,
          configuration: {
            modelContext: {
              read: async () => (await service.acquire()).model.list().then(result => result.data.map(model => ({
                model: `${model.providerID}/${model.modelID}`,
                defaultTokens: model.limit.context,
                maximumTokens: model.limit.context,
              }))),
            },
            models: {
              read: async () => {
                const client = await service.acquire();
                const [models, defaultModel] = await Promise.all([client.model.list(), client.model.default()]);
                return models.data.map(model => ({
                  id: `${model.providerID}/${model.modelID}`,
                  displayName: model.name,
                  description: model.family ?? "",
                  hidden: !model.enabled || model.status === "deprecated",
                  isDefault: defaultModel.data?.id === model.id,
                  supportsPersonality: false,
                  supportsReasoningEffort: model.variants.length > 0,
                  supportedReasoningEfforts: model.variants.map(variant => variant.id),
                  defaultReasoningEffort: null,
                  supportsVision: model.capabilities.input.includes("image"),
                  supportsFastMode: false,
                  inputModalities: [...model.capabilities.input],
                  maxContextWindowTokens: model.limit.context,
                  contextWindow: { defaultTokens: model.limit.context, maximumTokens: model.limit.context },
                  additionalSpeedTiers: [],
                  policyState: null,
                  billingMultiplier: null,
                }));
              },
            },
            guidance: { contains: async sections => sections.map(() => false) },
          },
        },
      },
      start: () => undefined,
      dispose: () => undefined,
    };
  },
  description: "Reload the OpenCode provider definition.",
  lifecycle: "atomic",
  provides: ["openCodeProvider"],
  requires: ["openCodeService", "openCodeThreadOperations", "codexExecutor"],
  safeAll: true,
  scope: "server:opencode/def",
  sources: [
    "daemon/server/providers/opencode/OpenCodeProvider.ts",
    "daemon/server/providers/opencode/OpenCodeToolsController.ts",
    "shared/workbench/provider/provider-registrations.ts",
  ].join("\n"),
});
