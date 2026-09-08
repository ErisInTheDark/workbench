/*
 * Keywords: stats, tokens, selection, pricing, contracts.
 * Exports:
 * - STATS_TOKEN_TYPES/StatsTokenType: independent selectable billing categories.
 * - WorkbenchStatsDetailedReadRequestSchema/WorkbenchStatsDetailedReadRequest: selected usage request.
 * - StatsCategoryCostsSchema/StatsCategoryCosts: costs attributed to each token category.
 * - WorkbenchStatsDetailedResponseSchema/WorkbenchStatsDetailedResponse: category-cost stats response.
 * - legacyStatsResponse: project detailed stats onto the unchanged legacy wire shape.
 * - detailedStatsResponse: omit cache efficiency for existing strict detailed clients.
 * - cacheStatsResponse: omit category breakdown facts for the first strict cache-efficiency clients.
 * - hasStatsCategoryCosts: narrow validated stats to the detailed contract.
 */
import { z } from "zod";
import { StatsResponseV2Schema, WorkbenchStatsReadRequestSchema, type WorkbenchStatsResponse } from "./workbench-stats-contract.ts";
import { StatsCacheEfficiencySchema } from "./workbench-stats-cache-contract.ts";

export const STATS_TOKEN_TYPES = ["input", "cache", "output"] as const;
export type StatsTokenType = typeof STATS_TOKEN_TYPES[number];
export const WorkbenchStatsDetailedReadRequestSchema = WorkbenchStatsReadRequestSchema.extend({
  tokenTypes: z.array(z.enum(STATS_TOKEN_TYPES)).max(3).default(() => [...STATS_TOKEN_TYPES]),
}).strict();
export type WorkbenchStatsDetailedReadRequest = z.input<typeof WorkbenchStatsDetailedReadRequestSchema>;

export const StatsCategoryCostsSchema = z.object({
  input: z.number().finite().nonnegative(),
  cache: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
}).strict();
export type StatsCategoryCosts = z.infer<typeof StatsCategoryCostsSchema>;
export const WorkbenchStatsDetailedResponseSchema = StatsResponseV2Schema.extend({
  // Omission means an older server cannot supply independent cache facts, not zero usage.
  cacheEfficiency: StatsCacheEfficiencySchema.optional(),
  cost: StatsResponseV2Schema.shape.cost.extend({
    byTokenType: StatsCategoryCostsSchema,
    buckets: z.array(z.object({
      startedAt: z.number().finite().nonnegative(),
      totalUsd: z.number().finite().nonnegative(),
      byTokenType: StatsCategoryCostsSchema,
    }).strict()).max(90),
  }).strict(),
}).strict();
export type WorkbenchStatsDetailedResponse = z.infer<typeof WorkbenchStatsDetailedResponseSchema>;

export function hasStatsCategoryCosts(stats: WorkbenchStatsResponse): stats is WorkbenchStatsDetailedResponse {
  return "byTokenType" in stats.cost;
}

export function legacyStatsResponse(stats: WorkbenchStatsDetailedResponse): WorkbenchStatsResponse {
  return {
    ...detailedStatsResponse(stats),
    cost: {
      basis: stats.cost.basis,
      totalUsd: stats.cost.totalUsd,
      buckets: stats.cost.buckets.map(({ startedAt, totalUsd }) => ({ startedAt, totalUsd })),
    },
  };
}

export function detailedStatsResponse(stats: WorkbenchStatsDetailedResponse): Omit<WorkbenchStatsDetailedResponse, "cacheEfficiency"> {
  const { cacheEfficiency: _cacheEfficiency, ...detailed } = stats;
  return detailed;
}

export function cacheStatsResponse(stats: WorkbenchStatsDetailedResponse): WorkbenchStatsDetailedResponse {
  if (!stats.cacheEfficiency) return stats;
  return {
    ...stats,
    cacheEfficiency: {
      ...stats.cacheEfficiency,
      worstThreads: stats.cacheEfficiency.worstThreads.map(({ cacheWriteInputTokens: _writes, ...thread }) => thread),
    },
  };
}
