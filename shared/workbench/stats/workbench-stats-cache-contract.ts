/*
 * Keywords: stats, input cache, percentage, buckets, leaderboard.
 * Exports:
 * - StatsCacheEfficiencySchema/StatsCacheEfficiency: complete-input cache aggregates, independent of billing-category selection.
 */
import { z } from "zod";

const tokens = z.number().finite().nonnegative();
const cacheTotals = z.object({
  inputTokens: tokens,
  cachedInputTokens: tokens,
  cacheHitPercent: z.number().finite().min(0).max(100).nullable(),
}).strict();

export const StatsCacheEfficiencySchema = z.object({
  totals: cacheTotals,
  buckets: z.array(cacheTotals.extend({ startedAt: z.number().finite().nonnegative() }).strict()).max(90),
  worstThreads: z.array(cacheTotals.extend({
    cacheWriteInputTokens: tokens.optional(),
    inputTokens: tokens.positive(),
    cacheHitPercent: z.number().finite().min(0).max(100),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    title: z.string().max(500),
  }).strict()).max(12),
}).strict();
export type StatsCacheEfficiency = z.infer<typeof StatsCacheEfficiencySchema>;
