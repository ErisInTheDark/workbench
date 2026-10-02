/*
 * Exports:
 * - ClaudeSessionCall: one billed main-chain API call read from a Claude session log.
 * - ClaudeSessionCallReader: incremental session-log line parser that dedupes calls by message id.
 * - ClaudeTurnUsage: one Workbench turn's billing model and thread-cumulative usage.
 * - claudeTurnUsage: assign session calls to Workbench turns by start time and accumulate usage.
 */
import { z } from "zod";
import type { WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type { ThreadTokenUsage } from "workbench-shared/workbench/thread/thread-context-usage";
import { claudeTokenBreakdown } from "./ClaudeTranscriptAdapter";

type Breakdown = ThreadTokenUsage["total"];

export interface ClaudeSessionCall {
  model: string;
  occurredAt: number;
  usage: Breakdown;
}

export interface ClaudeTurnUsage {
  turnId: WorkbenchTurnId;
  model: string | null;
  mixedModels: boolean;
  cumulative: Breakdown;
}

const AssistantLineSchema = z.object({
  type: z.literal("assistant"),
  isSidechain: z.boolean().optional(),
  timestamp: z.string(),
  message: z.object({
    id: z.string(),
    model: z.string(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
    }),
  }),
});

// Claude marks locally generated messages (errors, interruptions) with this model; they are never billed.
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Claude writes one session line per content block, each repeating its message's usage; the last line of a
 * message carries its final output count. Sidechain calls belong to subagents, not the main conversation.
 */
export class ClaudeSessionCallReader {
  private readonly calls = new Map<string, ClaudeSessionCall>();
  private pendingMalformed = 0;
  /** Lines that looked like assistant calls but failed to parse, excluding a trailing line still being written. */
  malformed = 0;

  push(line: string) {
    // Only the final line may be half-written; any later line proves an earlier failure was real.
    this.malformed += this.pendingMalformed;
    this.pendingMalformed = 0;
    // Cheap prefilter: most bytes are tool results and user lines.
    if (!line.includes("\"type\":\"assistant\"")) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.pendingMalformed = 1;
      return;
    }
    const parsed = AssistantLineSchema.safeParse(value);
    const occurredAt = parsed.success ? Date.parse(parsed.data.timestamp) : Number.NaN;
    if (!parsed.success || !Number.isFinite(occurredAt)) {
      this.malformed += 1;
      return;
    }
    const { isSidechain, message } = parsed.data;
    if (isSidechain || message.model === SYNTHETIC_MODEL) return;
    const first = this.calls.get(message.id);
    this.calls.set(message.id, {
      model: message.model,
      occurredAt: first?.occurredAt ?? occurredAt,
      usage: claudeTokenBreakdown({
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? null,
        cache_read_input_tokens: message.usage.cache_read_input_tokens ?? null,
      }),
    });
  }

  read(): ClaudeSessionCall[] {
    return [...this.calls.values()];
  }
}

function addBreakdowns(left: Breakdown, right: Breakdown): Breakdown {
  return {
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

const EMPTY: Breakdown = {
  cacheWriteInputTokens: 0, cachedInputTokens: 0, inputTokens: 0,
  outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
};

/**
 * Each call belongs to the last turn that started at or before it; calls before the first turn belong to the
 * first turn. Every started turn gets a row, so turns without calls carry the previous total forward.
 */
export function claudeTurnUsage(
  calls: readonly ClaudeSessionCall[],
  turns: readonly { id: WorkbenchTurnId; startedAt: number | null }[],
): ClaudeTurnUsage[] {
  const started = turns
    .filter((turn): turn is { id: WorkbenchTurnId; startedAt: number } => turn.startedAt !== null)
    .sort((left, right) => left.startedAt - right.startedAt);
  const perTurn = started.map(() => ({ usage: EMPTY, models: new Map<string, number>() }));
  if (!started.length) return [];
  for (const call of calls) {
    let index = 0;
    while (index + 1 < started.length && started[index + 1]!.startedAt <= call.occurredAt) index += 1;
    const owner = perTurn[index]!;
    owner.usage = addBreakdowns(owner.usage, call.usage);
    owner.models.set(call.model, (owner.models.get(call.model) ?? 0) + call.usage.inputTokens);
  }
  let cumulative = EMPTY;
  return started.map((turn, index) => {
    const { usage, models } = perTurn[index]!;
    cumulative = addBreakdowns(cumulative, usage);
    // The main model carries the conversation context; helper models only add side calls.
    const model = [...models].sort(([, left], [, right]) => right - left)[0]?.[0] ?? null;
    return { turnId: turn.id, model, mixedModels: models.size > 1, cumulative };
  });
}
