/*
 * Keywords: sqlite, usage, cumulative tokens, selection, pricing, ranking.
 * Exports:
 * - default WorkbenchUsageStatsRepository: derive selected usage and spend from ordered cumulative facts.
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import { statsRangeShape } from "workbench-shared/workbench/stats/workbench-stats-contract";
import {
  STATS_TOKEN_TYPES,
  type WorkbenchStatsDetailedReadRequest,
  type WorkbenchStatsDetailedResponse,
} from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import { WORKBENCH_STATS_USAGE_DATA_VERSION, type WorkbenchCumulativeTokenUsage } from "workbench-shared/workbench/stats/workbench-stats-usage";
import { defaultApiPricingModel, estimateApiTokenCost } from "../../stats/api-pricing.ts";

interface TokenRow {
  attribution_model: string | null;
  attribution_source: "thread" | "project" | "provider" | null;
  cumulative_cache_write_input_tokens: number;
  cumulative_cached_input_tokens: number;
  cumulative_input_tokens: number;
  cumulative_output_tokens: number;
  cumulative_reasoning_output_tokens: number;
  cumulative_total_tokens: number;
  harness_id: WorkbenchHarness;
  model: string | null;
  model_is_mixed: number;
  occurred_at: number;
  project_id: string;
  service_tier: string | null;
  thread_id: string;
  title: string;
  turn_index: number;
}

const emptyTotals = () => ({ all: 0, cachedInput: 0, cacheWriteInput: 0, input: 0, output: 0, uncachedInput: 0 });
const emptyCosts = () => ({ input: 0, cache: 0, output: 0 });
const money = (value: number) => Number(value.toFixed(8));

function cumulativeUsage(row: TokenRow): WorkbenchCumulativeTokenUsage {
  return {
    cacheWriteInputTokens: row.cumulative_cache_write_input_tokens,
    cachedInputTokens: row.cumulative_cached_input_tokens,
    inputTokens: row.cumulative_input_tokens,
    outputTokens: row.cumulative_output_tokens,
    reasoningOutputTokens: row.cumulative_reasoning_output_tokens,
    totalTokens: row.cumulative_total_tokens,
  };
}

function usageDelta(current: WorkbenchCumulativeTokenUsage, previous: WorkbenchCumulativeTokenUsage | undefined) {
  if (!previous || current.totalTokens < previous.totalTokens) return current;
  const delta = (key: keyof WorkbenchCumulativeTokenUsage) => current.totalTokens === previous.totalTokens
    ? 0 : Math.max(0, current[key] - previous[key]);
  return {
    cacheWriteInputTokens: delta("cacheWriteInputTokens"), cachedInputTokens: delta("cachedInputTokens"),
    inputTokens: delta("inputTokens"), outputTokens: delta("outputTokens"),
    reasoningOutputTokens: delta("reasoningOutputTokens"), totalTokens: delta("totalTokens"),
  };
}

export default class WorkbenchUsageStatsRepository {
  constructor(private readonly database: Database.Database) {}

  read(request: WorkbenchStatsDetailedReadRequest, now: number) {
    const shape = statsRangeShape(request.range, now);
    const selected = new Set(request.tokenTypes ?? STATS_TOKEN_TYPES);
    const tokenBuckets = Array.from({ length: shape.count }, (_, index) => ({
      ...emptyTotals(), startedAt: shape.startedAt + index * shape.bucketMs,
    }));
    const costBuckets = tokenBuckets.map(({ startedAt }) => ({ startedAt, totalUsd: 0, byTokenType: emptyCosts() }));
    const totals = emptyTotals();
    const costs = emptyCosts();
    const basis = { defaultModelTokens: 0, exactModelTokens: 0, projectInferredModelTokens: 0, threadInferredModelTokens: 0 };
    const providers = new Set<WorkbenchHarness>();
    const models = new Set<string>();
    const threads = new Set<string>();
    let turnCount = 0;
    const modelRows = new Map<string, WorkbenchStatsDetailedResponse["models"][number] & { threads: Set<string> }>();
    const threadRows = new Map<string, Omit<WorkbenchStatsDetailedResponse["topThreads"][number], "models" | "providers"> & {
      models: Set<string>; providers: Set<WorkbenchHarness>;
    }>();
    const previousUsage = new Map<string, WorkbenchCumulativeTokenUsage>();
    const rows = this.database.prepare(`
      SELECT u.*, a.model attribution_model, a.source attribution_source,
        COALESCE(t.started_at, t.created_at) occurred_at, t.harness_id, t.turn_index,
        wt.id thread_id, wt.project_id, wt.title
      FROM thread_turn_usage u JOIN thread_turns t ON t.id = u.turn_id
      JOIN workbench_threads wt ON wt.id = t.thread_id
      LEFT JOIN thread_usage_model_attributions a ON a.turn_id = u.turn_id
      WHERE u.usage_data_version = ? AND (? IS NULL OR wt.project_id = ?)
      ORDER BY wt.id, t.turn_index
    `).all(WORKBENCH_STATS_USAGE_DATA_VERSION, request.projectId, request.projectId) as TokenRow[];
    for (const row of rows) {
      const cumulative = cumulativeUsage(row);
      const previous = previousUsage.get(row.thread_id);
      previousUsage.set(row.thread_id, cumulative);
      if (!previous && row.turn_index > 0) continue;
      const usage = usageDelta(cumulative, previous);
      if (row.occurred_at < shape.startedAt || row.occurred_at > now) continue;
      const model = row.model || row.attribution_model || defaultApiPricingModel(row.harness_id);
      providers.add(row.harness_id);
      if (request.provider && row.harness_id !== request.provider) continue;
      models.add(model);
      if (request.model && model !== request.model) continue;
      const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
      const written = Math.min(Math.max(0, usage.inputTokens - cached), usage.cacheWriteInputTokens);
      const fresh = Math.max(0, usage.inputTokens - cached - written);
      const values = {
        ...emptyTotals(),
        cachedInput: selected.has("cache") ? cached : 0,
        cacheWriteInput: selected.has("cache") ? written : 0,
        uncachedInput: selected.has("input") ? fresh : 0,
        output: selected.has("output") ? usage.outputTokens : 0,
      };
      values.input = values.cachedInput + values.cacheWriteInput + values.uncachedInput;
      values.all = values.input + values.output;
      // Keep the legacy count of recorded turns, including zero deltas.
      if (values.all === 0 && request.tokenTypes !== undefined) continue;
      const position = Math.min(shape.count - 1, Math.floor((row.occurred_at - shape.startedAt) / shape.bucketMs));
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        totals[key] += values[key];
        tokenBuckets[position]![key] += values[key];
      }
      // Rate selection uses the complete fact, not the visible categories.
      const estimate = estimateApiTokenCost({
        cacheWriteInputTokens: written, cachedInputTokens: cached, inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens, model, provider: row.harness_id, serviceTier: row.service_tier,
        modelSource: row.model ? row.model_is_mixed ? "inferred" : "exact"
          : row.attribution_source === "thread" || row.attribution_source === "project" ? "inferred" : "default",
      });
      let costUsd = 0;
      for (const key of STATS_TOKEN_TYPES) {
        const value = selected.has(key) ? estimate.byTokenType[key] : 0;
        costUsd += value;
        costs[key] += value;
        costBuckets[position]!.byTokenType[key] += value;
      }
      costBuckets[position]!.totalUsd += costUsd;
      const basisKey = estimate.source === "exact" ? "exactModelTokens"
        : estimate.source === "default" ? "defaultModelTokens"
          : !row.model && row.attribution_source === "project" ? "projectInferredModelTokens" : "threadInferredModelTokens";
      basis[basisKey] += values.all;
      threads.add(row.thread_id);
      turnCount += 1;
      const modelKey = `${row.harness_id}\0${model}`;
      const modelRow = modelRows.get(modelKey) ?? {
        costUsd: 0, defaultModelTokens: 0, inferredModelTokens: 0, model, provider: row.harness_id,
        threadCount: 0, threads: new Set<string>(), tokens: 0,
      };
      modelRow.costUsd += costUsd;
      modelRow.tokens += values.all;
      modelRow.threads.add(row.thread_id);
      if (estimate.source === "default") modelRow.defaultModelTokens += values.all;
      if (estimate.source === "inferred") modelRow.inferredModelTokens += values.all;
      modelRows.set(modelKey, modelRow);
      const threadRow = threadRows.get(row.thread_id) ?? {
        costUsd: 0, models: new Set<string>(), projectId: row.project_id, providers: new Set<WorkbenchHarness>(),
        threadId: row.thread_id, title: row.title, tokens: 0, sharePercent: 0,
      };
      threadRow.costUsd += costUsd;
      threadRow.models.add(model);
      threadRow.providers.add(row.harness_id);
      threadRow.tokens += values.all;
      threadRows.set(row.thread_id, threadRow);
    }
    return {
      bucketUnit: shape.bucketUnit,
      startedAt: shape.startedAt,
      cost: {
        basis, byTokenType: { input: money(costs.input), cache: money(costs.cache), output: money(costs.output) },
        buckets: costBuckets.map((bucket) => ({
          ...bucket, totalUsd: money(bucket.totalUsd),
          byTokenType: { input: money(bucket.byTokenType.input), cache: money(bucket.byTokenType.cache), output: money(bucket.byTokenType.output) },
        })),
        totalUsd: money(costs.input + costs.cache + costs.output),
      },
      models: [...modelRows.values()].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
        .slice(0, 100).map(({ threads: modelThreads, ...row }) => ({ ...row, costUsd: money(row.costUsd), threadCount: modelThreads.size })),
      summary: { cacheHitPercent: totals.input ? totals.cachedInput / totals.input * 100 : 0, threadCount: threads.size, turnCount },
      tokens: { buckets: tokenBuckets, totals },
      topThreads: [...threadRows.values()].sort((a, b) => b.tokens - a.tokens || a.title.localeCompare(b.title) || a.threadId.localeCompare(b.threadId))
        .slice(0, 12).map((row) => ({
          ...row, costUsd: money(row.costUsd), models: [...row.models].sort().slice(0, 20), providers: [...row.providers].sort(),
          sharePercent: totals.all ? Math.min(100, row.tokens / totals.all * 100) : 0,
        })),
      usageFilters: { models: [...models].sort().slice(0, 100), providers: [...providers].sort() },
    };
  }
}
