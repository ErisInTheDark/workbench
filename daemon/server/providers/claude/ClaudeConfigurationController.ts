/*
 * Exports:
 * - claudeAccountLimits: map Claude plan usage windows into the shared account-limit contract.
 * - default ClaudeConfigurationController: read Claude Code model choices and plan usage through idle control queries.
 */
import { query, type ModelInfo, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import type { WorkbenchAccountLimits, WorkbenchRateLimitWindow } from "workbench-shared/workbench/provider/provider-account";
import { claudeEnvironment, claudeExecutable } from "./claude-process-options";

type ClaudeUsage = Awaited<ReturnType<Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]>>;
type ClaudeUsageWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

function modelOption(model: ModelInfo): WorkbenchModelOption {
  const efforts = model.supportedEffortLevels ?? [];
  return {
    id: model.resolvedModel ?? model.value,
    aliases: model.resolvedModel && model.resolvedModel !== model.value ? [model.value] : [],
    displayName: model.value === "default" ? model.resolvedModel ?? model.displayName : model.displayName,
    description: model.description,
    hidden: false,
    isDefault: false,
    supportsPersonality: false,
    supportsReasoningEffort: model.supportsEffort ?? efforts.length > 0,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: null,
    supportsVision: true,
    supportsFastMode: model.supportsFastMode ?? false,
    inputModalities: ["text", "image"],
    maxContextWindowTokens: null,
    contextWindow: null,
    additionalSpeedTiers: [],
    policyState: null,
    billingMultiplier: null,
  };
}

function usageWindow(value: ClaudeUsageWindow, windowDurationMins: number): WorkbenchRateLimitWindow | null {
  if (!value || value.utilization === null) return null;
  const resetsAt = value.resets_at ? Date.parse(value.resets_at) : Number.NaN;
  return {
    usedPercent: value.utilization, windowDurationMins,
    resetsAt: Number.isFinite(resetsAt) ? Math.floor(resetsAt / 1_000) : null,
  };
}

export function claudeAccountLimits(usage: Pick<ClaudeUsage, "rate_limits" | "subscription_type">): WorkbenchAccountLimits {
  const limits = usage.rate_limits;
  const extra = limits?.extra_usage?.is_enabled
    ? usageWindow({ utilization: limits.extra_usage.utilization, resets_at: null }, 43_200) : null;
  const windows = {
    five_hour: usageWindow(limits?.five_hour, 300),
    seven_day: usageWindow(limits?.seven_day, 10_080),
    extra_usage: extra,
  };
  return {
    preferredLimitId: null,
    rateLimits: {
      limitId: "claude",
      limitName: "Claude",
      primary: windows.five_hour,
      secondary: windows.seven_day,
      tertiary: windows.extra_usage,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: usage.subscription_type,
      rateLimitReachedType: Object.entries(windows).find(([, window]) => window && window.usedPercent >= 100)?.[0] ?? null,
    },
    rateLimitsByLimitId: null,
  };
}

export default class ClaudeConfigurationController {
  private readonly active = new Map<Query, AbortController>();
  private limitsRead: Promise<WorkbenchAccountLimits> | null = null;
  private disposed = false;

  constructor(
    private readonly createQuery: typeof query = query,
    private readonly resolveExecutable: () => string = claudeExecutable,
  ) {}

  dispose() {
    this.disposed = true;
    for (const [sdkQuery, lifetime] of this.active) {
      lifetime.abort();
      sdkQuery.close();
    }
    this.active.clear();
  }

  async models(): Promise<WorkbenchModelOption[]> {
    const choices = await this.withControlQuery("Claude model catalogue", sdkQuery => sdkQuery.supportedModels());
    const models = new Map<string, { option: WorkbenchModelOption; rank: number }>();
    for (const choice of choices) {
      const option = modelOption(choice);
      const rank = choice.value === option.id ? 2 : choice.value === "default" ? 0 : 1;
      const existing = models.get(option.id);
      if (!existing) {
        models.set(option.id, { option, rank });
        continue;
      }
      const aliases = [...new Set([...(existing.option.aliases ?? []), ...(option.aliases ?? [])])];
      models.set(option.id, {
        option: {
          ...(rank > existing.rank ? option : existing.option),
          aliases,
          supportsFastMode: existing.option.supportsFastMode || option.supportsFastMode,
        },
        rank: Math.max(existing.rank, rank),
      });
    }
    const nativeDefault = choices.find(choice => choice.value === "default");
    const defaultId = nativeDefault?.resolvedModel ?? nativeDefault?.value ?? models.keys().next().value;
    return [...models.values()].map(({ option }) => ({ ...option, isDefault: option.id === defaultId }));
  }

  /** Concurrent reads share one control process. */
  accountLimits(): Promise<WorkbenchAccountLimits> {
    this.limitsRead ??= this.withControlQuery("Claude account limits", sdkQuery =>
      sdkQuery.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
      .then(claudeAccountLimits)
      .finally(() => { this.limitsRead = null; });
    return this.limitsRead;
  }

  /** Run one control request against an idle Claude process that never receives a prompt. */
  private async withControlQuery<T>(name: string, operation: (sdkQuery: Query) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error(`${name} is closing.`);
    const lifetime = new AbortController();
    async function* idlePrompt(): AsyncGenerator<SDKUserMessage> {
      if (!lifetime.signal.aborted) {
        await new Promise<void>(resolve => lifetime.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    }
    const sdkQuery = this.createQuery({
      prompt: idlePrompt(),
      options: {
        abortController: lifetime,
        pathToClaudeCodeExecutable: this.resolveExecutable(),
        env: claudeEnvironment(process.env.WORKBENCH_CLAUDE_FAKE_ENDPOINT),
        settingSources: ["user"],
        tools: [],
      },
    });
    this.active.set(sdkQuery, lifetime);
    try {
      return await operation(sdkQuery);
    } finally {
      const stillActive = this.active.delete(sdkQuery);
      lifetime.abort();
      if (stillActive) sdkQuery.close();
    }
  }
}
