/*
 * Exports:
 * - default WorkbenchUsageStatsRepository: derive selected usage, priced spend, comparisons, and breakdowns from ordered cumulative facts.
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import {
  STATS_TOKEN_TYPES,
  statsPeriodShape,
  WorkbenchStatsReadRequestSchema,
  type StatsTokenType,
  type WorkbenchStatsReadRequest,
  type WorkbenchStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import { WORKBENCH_STATS_USAGE_DATA_VERSION, type WorkbenchCumulativeTokenUsage } from "workbench-shared/workbench/stats/workbench-stats-usage";
import type { StatsCacheEfficiency } from "workbench-shared/workbench/stats/workbench-stats-cache-contract";
import { estimateApiTokenCost } from "../../stats/api-pricing.ts";

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

interface Share { costUsd: number; threads: Set<string>; tokens: number; unpricedTokens: number }

const emptyTotals = () => ({ all: 0, cachedInput: 0, cacheWriteInput: 0, input: 0, output: 0, uncachedInput: 0 });
const emptyCosts = (): Record<StatsTokenType, number> => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const moneyCosts = (costs: Record<StatsTokenType, number>) =>
  Object.fromEntries(STATS_TOKEN_TYPES.map((key) => [key, money(costs[key])])) as Record<StatsTokenType, number>;
const emptyShare = (): Share => ({ costUsd: 0, threads: new Set(), tokens: 0, unpricedTokens: 0 });
const money = (value: number) => Number(value.toFixed(8));
/** Threads below this much uncached input are too small for their hit rate to mean anything. */
const MINIMUM_UNCACHED_FOR_HIT_RATE = 500_000;

function addShare(share: Share, threadId: string, tokens: number, costUsd: number | null) {
  share.threads.add(threadId);
  share.tokens += tokens;
  if (costUsd === null) share.unpricedTokens += tokens;
  else share.costUsd += costUsd;
}

function publicShare({ threads, costUsd, ...share }: Share) {
  return { ...share, costUsd: money(costUsd), threadCount: threads.size };
}

function cacheTotals(inputTokens: number, cachedInputTokens: number) {
  return { inputTokens, cachedInputTokens, cacheHitPercent: inputTokens ? cachedInputTokens / inputTokens * 100 : null };
}

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

/** Recorded models are exact; thread and project evidence infer one; earlier provider-default guesses are ignored. */
function resolvedModel(row: TokenRow) {
  if (row.model) return { model: row.model, source: row.model_is_mixed ? "inferred" as const : "exact" as const, basis: row.model_is_mixed ? "thread" as const : "exact" as const };
  if (row.attribution_model && (row.attribution_source === "thread" || row.attribution_source === "project")) {
    return { model: row.attribution_model, source: "inferred" as const, basis: row.attribution_source };
  }
  return { model: null, source: "inferred" as const, basis: null };
}

export default class WorkbenchUsageStatsRepository {
  constructor(private readonly database: Database.Database) {}

  read(input: WorkbenchStatsReadRequest, now: number) {
    const request = WorkbenchStatsReadRequestSchema.parse(input);
    const shape = statsPeriodShape(request.range, request.period, now);
    const previousStartedAt = shape.startedAt - shape.count * shape.bucketMs;
    const selected = new Set(request.tokenTypes);
    const tokenBuckets = Array.from({ length: shape.count }, (_, index) => ({
      ...emptyTotals(), startedAt: shape.startedAt + index * shape.bucketMs,
    }));
    const costBuckets = tokenBuckets.map(({ startedAt }) => ({ startedAt, totalUsd: 0, byTokenType: emptyCosts() }));
    const cacheBuckets = tokenBuckets.map(({ startedAt }) => ({ startedAt, inputTokens: 0, cachedInputTokens: 0 }));
    const totals = emptyTotals();
    const costs = emptyCosts();
    const basis = { exactModelTokens: 0, projectInferredModelTokens: 0, threadInferredModelTokens: 0, unpricedTokens: 0 };
    const previous = { costUsd: 0, threads: new Set<string>(), tokens: 0, turnCount: 0 };
    const providerFilters = new Set<WorkbenchHarness>();
    const modelFilters = new Set<string>();
    const threads = new Set<string>();
    let turnCount = 0;
    const activityBuckets = tokenBuckets.map(() => ({ threads: new Set<string>(), turnCount: 0 }));
    const models = new Map<string, Share & { inferredModelTokens: number; model: string | null; provider: WorkbenchHarness }>();
    const providers = new Map<WorkbenchHarness, Share>();
    const projects = new Map<string, Share>();
    const threadRows = new Map<string, Share & {
      harness: WorkbenchHarness; models: Set<string>; providers: Set<WorkbenchHarness>; projectId: string; title: string;
      modelShares: Map<string, Share & { model: string | null; provider: WorkbenchHarness }>;
      inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number;
    }>();
    const previousUsage = new Map<string, WorkbenchCumulativeTokenUsage>();
    // Rows arrive in turn order, so a thread's first row names the provider it started on.
    const firstHarness = new Map<string, WorkbenchHarness>();
    const rows = this.database.prepare(`
      SELECT u.*, a.model attribution_model, a.source attribution_source,
        COALESCE(t.started_at, t.created_at) occurred_at, t.harness_id, t.turn_index,
        wt.id thread_id, wt.project_id, wt.title
      FROM thread_turn_usage u JOIN thread_turns t ON t.id = u.turn_id
      JOIN workbench_threads wt ON wt.id = t.thread_id
      LEFT JOIN thread_usage_model_attributions a ON a.turn_id = u.turn_id
      WHERE u.usage_data_version = @version
        AND (@projects IS NULL OR wt.project_id IN (SELECT value FROM json_each(@projects)))
      ORDER BY wt.id, t.turn_index
    `).all({
      version: WORKBENCH_STATS_USAGE_DATA_VERSION,
      projects: request.projectIds === null ? null : JSON.stringify(request.projectIds),
    }) as TokenRow[];
    for (const row of rows) {
      const cumulative = cumulativeUsage(row);
      const prior = previousUsage.get(row.thread_id);
      previousUsage.set(row.thread_id, cumulative);
      if (!firstHarness.has(row.thread_id)) firstHarness.set(row.thread_id, row.harness_id);
      // A thread's first recorded fact after turn zero is only a baseline for later deltas.
      if (!prior && row.turn_index > 0) continue;
      const usage = usageDelta(cumulative, prior);
      if (row.occurred_at < previousStartedAt || row.occurred_at >= shape.endedAt || row.occurred_at > now) continue;
      const inWindow = row.occurred_at >= shape.startedAt;
      const { model, source, basis: basisKind } = resolvedModel(row);
      if (inWindow) providerFilters.add(row.harness_id);
      if (request.provider && row.harness_id !== request.provider) continue;
      if (inWindow && model) modelFilters.add(model);
      if (request.model && model !== request.model) continue;
      const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
      const written = Math.min(Math.max(0, usage.inputTokens - cached), usage.cacheWriteInputTokens);
      const fresh = Math.max(0, usage.inputTokens - cached - written);
      const values = {
        ...emptyTotals(),
        cachedInput: selected.has("cacheRead") ? cached : 0,
        cacheWriteInput: selected.has("cacheWrite") ? written : 0,
        uncachedInput: selected.has("input") ? fresh : 0,
        output: selected.has("output") ? usage.outputTokens : 0,
      };
      values.input = values.cachedInput + values.cacheWriteInput + values.uncachedInput;
      values.all = values.input + values.output;
      // Rate tiers use the complete fact, not only the visible categories.
      const estimate = estimateApiTokenCost({
        cacheWriteInputTokens: written, cachedInputTokens: cached, inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens, model, modelSource: source, occurredAt: row.occurred_at,
        provider: row.harness_id, serviceTier: row.service_tier,
      });
      const costUsd = estimate
        ? STATS_TOKEN_TYPES.reduce((sum, key) => sum + (selected.has(key) ? estimate.byTokenType[key] : 0), 0)
        : null;
      if (!inWindow) {
        if (values.all === 0) continue;
        previous.tokens += values.all;
        previous.costUsd += costUsd ?? 0;
        previous.threads.add(row.thread_id);
        previous.turnCount += 1;
        continue;
      }
      const position = Math.min(shape.count - 1, Math.floor((row.occurred_at - shape.startedAt) / shape.bucketMs));
      cacheBuckets[position]!.inputTokens += usage.inputTokens;
      cacheBuckets[position]!.cachedInputTokens += cached;
      const threadRow = threadRows.get(row.thread_id) ?? {
        ...emptyShare(), harness: firstHarness.get(row.thread_id)!, models: new Set<string>(), providers: new Set<WorkbenchHarness>(), modelShares: new Map(),
        projectId: row.project_id, title: row.title, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      };
      threadRow.inputTokens += usage.inputTokens;
      threadRow.cachedInputTokens += cached;
      threadRow.cacheWriteInputTokens += written;
      threadRows.set(row.thread_id, threadRow);
      if (values.all === 0) continue;
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        totals[key] += values[key];
        tokenBuckets[position]![key] += values[key];
      }
      if (estimate) {
        for (const key of STATS_TOKEN_TYPES) {
          const value = selected.has(key) ? estimate.byTokenType[key] : 0;
          costs[key] += value;
          costBuckets[position]!.byTokenType[key] += value;
        }
        costBuckets[position]!.totalUsd += costUsd ?? 0;
      }
      if (!estimate) basis.unpricedTokens += values.all;
      else if (basisKind === "exact") basis.exactModelTokens += values.all;
      else if (basisKind === "project") basis.projectInferredModelTokens += values.all;
      else basis.threadInferredModelTokens += values.all;
      threads.add(row.thread_id);
      turnCount += 1;
      activityBuckets[position]!.threads.add(row.thread_id);
      activityBuckets[position]!.turnCount += 1;
      const modelKey = `${row.harness_id}\0${model ?? ""}`;
      const modelRow = models.get(modelKey) ?? { ...emptyShare(), inferredModelTokens: 0, model, provider: row.harness_id };
      addShare(modelRow, row.thread_id, values.all, costUsd);
      if (source === "inferred" && model) modelRow.inferredModelTokens += values.all;
      models.set(modelKey, modelRow);
      const providerRow = providers.get(row.harness_id) ?? emptyShare();
      addShare(providerRow, row.thread_id, values.all, costUsd);
      providers.set(row.harness_id, providerRow);
      const projectRow = projects.get(row.project_id) ?? emptyShare();
      addShare(projectRow, row.thread_id, values.all, costUsd);
      projects.set(row.project_id, projectRow);
      addShare(threadRow, row.thread_id, values.all, costUsd);
      const threadModel = threadRow.modelShares.get(modelKey) ?? { ...emptyShare(), model, provider: row.harness_id };
      addShare(threadModel, row.thread_id, values.all, costUsd);
      threadRow.modelShares.set(modelKey, threadModel);
      if (model) threadRow.models.add(model);
      threadRow.providers.add(row.harness_id);
    }
    const byTokens = <T extends { tokens: number }>(left: T, right: T) => right.tokens - left.tokens;
    const modelRows = [...models.values()].sort((left, right) => byTokens(left, right) || (left.model ?? "").localeCompare(right.model ?? ""));
    const cacheEfficiency: StatsCacheEfficiency = {
      totals: cacheTotals(
        cacheBuckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0),
        cacheBuckets.reduce((sum, bucket) => sum + bucket.cachedInputTokens, 0),
      ),
      buckets: cacheBuckets.map(({ startedAt, inputTokens, cachedInputTokens }) => ({ startedAt, ...cacheTotals(inputTokens, cachedInputTokens) })),
      worstThreads: [...threadRows.entries()]
        .filter(([, row]) => row.inputTokens - row.cachedInputTokens >= MINIMUM_UNCACHED_FOR_HIT_RATE)
        .map(([threadId, { harness, projectId, title, inputTokens, cachedInputTokens, cacheWriteInputTokens }]) => ({
          harness, projectId, threadId, title, inputTokens, cachedInputTokens, cacheWriteInputTokens,
          cacheHitPercent: cachedInputTokens / inputTokens * 100,
        }))
        .sort((a, b) => a.cacheHitPercent - b.cacheHitPercent || b.inputTokens - a.inputTokens || a.threadId.localeCompare(b.threadId))
        .slice(0, 12),
    };
    return {
      bucketUnit: shape.bucketUnit,
      cacheEfficiency,
      cost: {
        basis,
        buckets: costBuckets.map((bucket) => ({
          startedAt: bucket.startedAt, totalUsd: money(bucket.totalUsd),
          byTokenType: moneyCosts(bucket.byTokenType),
        })),
        byTokenType: moneyCosts(costs),
        totalUsd: money(STATS_TOKEN_TYPES.reduce((sum, key) => sum + costs[key], 0)),
        unpricedModels: modelRows.filter((row) => row.unpricedTokens > 0).slice(0, 50)
          .map(({ model, provider, unpricedTokens }) => ({ model, provider, tokens: unpricedTokens })),
      },
      models: modelRows.slice(0, 100).map(({ model, provider, inferredModelTokens, ...share }) => ({
        ...publicShare(share), inferredModelTokens, model, provider,
      })),
      previous: { costUsd: money(previous.costUsd), threadCount: previous.threads.size, tokens: previous.tokens, turnCount: previous.turnCount },
      projectIds: request.projectIds,
      projects: [...projects.entries()].map(([projectId, share]) => ({ ...publicShare(share), projectId })).sort(byTokens).slice(0, 100),
      providers: [...providers.entries()].map(([provider, share]) => ({ ...publicShare(share), provider })).sort(byTokens),
      range: request.range,
      startedAt: shape.startedAt,
      summary: {
        buckets: tokenBuckets.map(({ startedAt }, index) => ({
          startedAt, threadCount: activityBuckets[index]!.threads.size, turnCount: activityBuckets[index]!.turnCount,
        })),
        threadCount: threads.size,
        turnCount,
      },
      tokens: { buckets: tokenBuckets, totals },
      topThreads: [...threadRows.entries()].filter(([, row]) => row.tokens > 0)
        .sort(([leftId, left], [rightId, right]) => right.tokens - left.tokens || left.title.localeCompare(right.title) || leftId.localeCompare(rightId))
        .slice(0, 12)
        .map(([threadId, row]) => ({
          costUsd: money(row.costUsd), tokens: row.tokens, unpricedTokens: row.unpricedTokens,
          models: [...row.models].sort().slice(0, 20),
          modelShares: [...row.modelShares.values()].sort(byTokens).slice(0, 20)
            .map(({ model, provider, costUsd, tokens, unpricedTokens }) => ({ costUsd: money(costUsd), model, provider, tokens, unpricedTokens })),
          harness: row.harness, projectId: row.projectId, providers: [...row.providers].sort(),
          sharePercent: totals.all ? Math.min(100, row.tokens / totals.all * 100) : 0, threadId, title: row.title,
        })),
      usageFilters: { models: [...modelFilters].sort().slice(0, 100), providers: [...providerFilters].sort() },
    } satisfies Partial<WorkbenchStatsResponse>;
  }
}
