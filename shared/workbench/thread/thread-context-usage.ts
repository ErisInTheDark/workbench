/*
 * Keywords: thread, context, usage, validation, snapshot.
 * Exports:
 * - ThreadTokenUsageSchema: validate provider context measurements without changing their accounting meaning.
 * - ThreadContextUsageSnapshot: distinguish initialised unavailable evidence from an unread snapshot.
 */
import { z } from "zod";
import type { ThreadTokenUsage } from "../../codex/generated/app-server/v2/ThreadTokenUsage";

const breakdown = z.object({
  cacheWriteInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export const ThreadTokenUsageSchema = z.object({
  last: breakdown,
  total: breakdown,
  modelContextWindow: z.number().int().positive().nullable(),
}).transform((usage): ThreadTokenUsage => ({ ...usage, modelContextWindow: usage.modelContextWindow ?? null }));

export interface ThreadContextUsageSnapshot {
  tokenUsage: ThreadTokenUsage | null;
}
