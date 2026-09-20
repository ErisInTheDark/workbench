/*
 * Exports:
 * - openCodeAccountLimits: map credential-free Go quota into the shared account contract.
 * - default OpenCodeProvider: bind graph-owned OpenCode capabilities to the daemon provider contract.
 */
import ReloadableNode from "../../ReloadableNode";
import type { DaemonProcessContext } from "../../daemon-process-context";
import type { DaemonProviderNotification, DaemonRuntimeObjects } from "../../daemon-runtime-objects";
import OpenCodeToolsController from "./OpenCodeToolsController";
import CodexShellController from "../../CodexShellController";
import type { OpenCodeGoQuota } from "./opencode-workbench-rpc";
import { openCodeWorkbenchRpc } from "./opencode-workbench-rpc";

export function openCodeAccountLimits(quota: OpenCodeGoQuota) {
  const window = (kind: "rolling" | "weekly" | "monthly", duration: number) => {
    const value = quota.windows?.[kind];
    return value ? {
      usedPercent: value.percent,
      windowDurationMins: duration,
      resetsAt: Math.floor(value.resetsAt / 1_000),
    } : null;
  };
  const reached = quota.windows
    ? Object.entries(quota.windows).find(([, value]) => value.percent >= 100)?.[0] ?? null
    : null;
  return {
    preferredLimitId: "opencode-go",
    rateLimits: {
      limitId: "opencode-go",
      limitName: "OpenCode Go",
      primary: window("rolling", 300),
      secondary: window("weekly", 10_080),
      tertiary: window("monthly", 43_200),
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: quota.available ? "go" : null,
      rateLimitReachedType: reached,
    },
    rateLimitsByLimitId: null,
  };
}

export default ReloadableNode.define<DaemonProcessContext, DaemonRuntimeObjects, DaemonProviderNotification>()({
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
          account: {
            limits: {
              read: async () => openCodeAccountLimits(
                await (await service.acquire()).rpc(openCodeWorkbenchRpc).goQuota({}),
              ),
            },
          },
          configuration: {
            modelContext: {
              read: async () => (await service.readModelCatalog()).models.map(model => ({
                model: `${model.providerID}/${model.modelID}`,
                defaultTokens: model.limit.context,
                maximumTokens: model.limit.context,
              })),
            },
            models: {
              read: async () => {
                const catalog = await service.readModelCatalog();
                return catalog.models.map(model => ({
                  id: `${model.providerID}/${model.modelID}`,
                  displayName: model.name,
                  description: model.family ?? "",
                  hidden: !model.enabled || model.status === "deprecated",
                  isDefault: catalog.defaultModel?.id === model.id,
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
