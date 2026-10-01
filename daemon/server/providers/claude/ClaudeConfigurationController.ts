/*
 * Exports:
 * - default ClaudeConfigurationController: read Claude Code model choices.
 */
import { query, type ModelInfo, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import { claudeEnvironment, claudeExecutable } from "./claude-process-options";

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

export default class ClaudeConfigurationController {
  private readonly active = new Map<Query, AbortController>();
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
    if (this.disposed) throw new Error("Claude model catalogue is closing.");
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
      const choices = await sdkQuery.supportedModels();
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
    } finally {
      const stillActive = this.active.delete(sdkQuery);
      lifetime.abort();
      if (stillActive) sdkQuery.close();
    }
  }
}
