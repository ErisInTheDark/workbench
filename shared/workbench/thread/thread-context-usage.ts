/*
 * Exports:
 * - ThreadTokenUsageSchema: validate provider context measurements without changing their accounting meaning.
 * - ThreadTokenUsage: Workbench-owned token accounting snapshot.
 * - ThreadContextUsageSnapshot: distinguish initialised unavailable evidence from an unread snapshot.
 */
import { z } from "zod";

const breakdown = z.object({
  cacheWriteInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export type ThreadTokenUsage = {
  last: z.infer<typeof breakdown>;
  total: z.infer<typeof breakdown>;
  modelContextWindow: number | null;
};

export const ThreadTokenUsageSchema = z.object({
  last: breakdown,
  total: breakdown,
  modelContextWindow: z.number().int().positive().nullable(),
}).transform((usage): ThreadTokenUsage => ({ ...usage, modelContextWindow: usage.modelContextWindow ?? null }));

export interface ThreadContextUsageSnapshot {
  tokenUsage: ThreadTokenUsage | null;
}
