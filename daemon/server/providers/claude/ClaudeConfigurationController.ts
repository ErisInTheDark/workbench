/*
 * Exports:
 * - claudeAccountLimits: map Claude plan usage windows into the shared account-limit contract.
 * - default ClaudeConfigurationController: read Claude Code model choices, context window bounds and defaults, and plan usage through idle control queries.
 */
import { query, type ModelInfo, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WorkbenchModelContextCapability } from "workbench-shared/types";
import type { WorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import type { WorkbenchAccountLimits, WorkbenchRateLimitWindow } from "workbench-shared/workbench/provider/provider-account";
import { contextWindowFloor } from "workbench-shared/workbench/thread/thread-profile";
import { claudeEnvironment, claudeExecutable } from "./claude-process-options";

type ClaudeUsage = Awaited<ReturnType<Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]>>;
type ClaudeUsageWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

/** Window probes spawn one Claude process each; bound how many run at once. */
const WINDOW_PROBE_CONCURRENCY = 4;

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
  /** Native window bounds per model for this provider lifetime; failed probes are dropped so a later read retries. */
  private readonly windows = new Map<string, Promise<WorkbenchModelContextCapability>>();
  private limitsRead: Promise<WorkbenchAccountLimits> | null = null;
  private disposed = false;

  constructor(
    private readonly createQuery: typeof query = query,
    private readonly resolveExecutable: () => string = claudeExecutable,
    private readonly warn: (message: string) => void = message => console.warn("[claude]", message),
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
    const models = await this.catalogue();
    const capabilities = await this.capabilities(models.map(model => model.id));
    return models.map(model => {
      const context = capabilities.find(capability => capability.model === model.id);
      if (!context) return model;
      return {
        ...model,
        maxContextWindowTokens: context.maximumTokens,
        contextWindow: context.maximumTokens > contextWindowFloor(context) ? {
          defaultTokens: context.defaultTokens, minimumTokens: context.minimumTokens, maximumTokens: context.maximumTokens,
        } : null,
      };
    });
  }

  /** Claude defaults to each model's native window; the floor is the window Claude uses with 1M context disabled. */
  async modelContext(): Promise<WorkbenchModelContextCapability[]> {
    return this.capabilities((await this.catalogue()).map(model => model.id));
  }

  /** The window a profile without a configured window means; null when the probe fails, so Claude keeps its own. */
  async defaultContextWindow(model: string): Promise<number | null> {
    try {
      return (await this.capability(model)).defaultTokens;
    } catch (error) {
      if (this.disposed) throw error;
      this.warn(`Default context window of ${model} is unavailable; Claude launches without a window: ${
        error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
      return null;
    }
  }

  private async capabilities(models: string[]) {
    const found: WorkbenchModelContextCapability[] = [];
    let next = 0;
    const work = async () => {
      while (next < models.length) {
        const model = models[next++]!;
        try {
          found.push(await this.capability(model));
        } catch (error) {
          if (this.disposed) throw error;
          this.warn(`Context window of ${model} is unavailable; it keeps Claude's native window: ${
            error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WINDOW_PROBE_CONCURRENCY, models.length) }, work));
    return found;
  }

  private capability(model: string) {
    let read = this.windows.get(model);
    if (!read) {
      read = Promise.all([this.window(model, {}), this.window(model, { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" })])
        .then(([native, standard]) => ({
          model, defaultTokens: native, minimumTokens: Math.min(standard, native), maximumTokens: native,
        }));
      const cached = read;
      this.windows.set(model, cached);
      cached.catch(() => { if (this.windows.get(model) === cached) this.windows.delete(model); });
    }
    return read;
  }

  private async window(model: string, env: NodeJS.ProcessEnv) {
    const usage = await this.withControlQuery(`Claude ${model} context window`, sdkQuery => sdkQuery.getContextUsage(), { model, env });
    if (!Number.isInteger(usage.rawMaxTokens) || usage.rawMaxTokens <= 0) {
      throw new Error(`Claude reported no context window for ${model}.`);
    }
    return usage.rawMaxTokens;
  }

  private async catalogue(): Promise<WorkbenchModelOption[]> {
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
  private async withControlQuery<T>(
    name: string, operation: (sdkQuery: Query) => Promise<T>, launch: { model?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<T> {
    if (this.disposed) throw new Error(`${name} is closing.`);
    const lifetime = new AbortController();
    async function* idlePrompt(): AsyncGenerator<SDKUserMessage> {
      if (!lifetime.signal.aborted) {
        await new Promise<void>(resolve => lifetime.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    }
    const env = { ...claudeEnvironment(process.env.WORKBENCH_CLAUDE_FAKE_ENDPOINT), ...launch.env };
    // A user-level cap would hide the model's own window from probes; launches apply Workbench's selection instead.
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const sdkQuery = this.createQuery({
      prompt: idlePrompt(),
      options: {
        abortController: lifetime,
        pathToClaudeCodeExecutable: this.resolveExecutable(),
        ...(launch.model ? { model: launch.model } : {}),
        env,
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
