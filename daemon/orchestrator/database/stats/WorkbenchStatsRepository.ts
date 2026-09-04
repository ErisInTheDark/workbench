/*
 * Exports:
 * - WorkbenchRateLimitObservation: typed durable rate-limit input. Keywords: stats, rate limits.
 * - default WorkbenchStatsRepository: own live claim/rate writes and bounded SQLite aggregates. Keywords: database, stats, claims, aggregation.
 * Local helpers: bound percentages, compare quota windows, derive cumulative usage deltas, and shape UTC buckets. Keywords: stats, time, aggregation, tokens.
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import {
  EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS,
  type WorkbenchStatsReadRequest,
  type WorkbenchStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import {
  WORKBENCH_STATS_USAGE_DATA_VERSION,
  type WorkbenchCumulativeTokenUsage,
} from "workbench-shared/workbench/stats/workbench-stats-usage";
import {
  API_PRICING_CATALOG_DATE,
  defaultApiPricingModel,
  estimateApiTokenCost,
  type ApiPricingModelSource,
} from "../../stats/api-pricing.ts";
import type { WorkbenchGitClaimSnapshot } from "../../stats/git-claim-observation.ts";

interface RateWindowObservation {
  durationMinutes: number | null;
  resetsAt: number | null;
  usedPercent: number;
}

export interface WorkbenchRateLimitObservation {
  harness: string;
  observedAt: number;
  snapshots: Array<{
    limitId: string;
    limitName: string | null;
    primary: RateWindowObservation | null;
    secondary: RateWindowObservation | null;
  }>;
}

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
  occurred_at: number;
  project_id: string;
  service_tier: string | null;
  thread_id: string;
  title: string;
  turn_index: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const RANGE_DAYS = { "7d": 7, "14d": 14, "30d": 30, "90d": 90, "365d": 365 } as const;
const emptyTotals = () => ({ all: 0, cachedInput: 0, cacheWriteInput: 0, input: 0, output: 0, uncachedInput: 0 });

function boundedPercent(value: number) {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function utcDayStart(value: number) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function bucketShape(range: WorkbenchStatsReadRequest["range"], now: number) {
  if (range !== "365d") {
    const count = RANGE_DAYS[range];
    const current = utcDayStart(now);
    return { bucketMs: DAY_MS, bucketUnit: "day" as const, count, startedAt: current - (count - 1) * DAY_MS };
  }
  const date = new Date(utcDayStart(now));
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const current = date.getTime() - mondayOffset * DAY_MS;
  const count = 53;
  return { bucketMs: 7 * DAY_MS, bucketUnit: "week" as const, count, startedAt: current - (count - 1) * 7 * DAY_MS };
}

function bucketIndex(timestamp: number, startedAt: number, bucketMs: number, count: number) {
  return Math.max(0, Math.min(count - 1, Math.floor((timestamp - startedAt) / bucketMs)));
}

function sameWindow(left: RateWindowObservation | null, right: RateWindowObservation | null) {
  return left?.durationMinutes === right?.durationMinutes
    && left?.resetsAt === right?.resetsAt
    && left?.usedPercent === right?.usedPercent;
}

function sourceFor(row: TokenRow): ApiPricingModelSource {
  if (row.model) return "exact";
  return row.attribution_source === "thread" || row.attribution_source === "project" ? "inferred" : "default";
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

function usageDelta(
  current: WorkbenchCumulativeTokenUsage,
  previous: WorkbenchCumulativeTokenUsage | null,
): WorkbenchCumulativeTokenUsage {
  if (!previous || current.totalTokens < previous.totalTokens) return current;
  if (current.totalTokens === previous.totalTokens) {
    return {
      cacheWriteInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
  }
  return {
    cacheWriteInputTokens: Math.max(0, current.cacheWriteInputTokens - previous.cacheWriteInputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
  };
}

export default class WorkbenchStatsRepository {
  constructor(private readonly database: Database.Database) {}

  recordClaimSnapshot(snapshot: WorkbenchGitClaimSnapshot) {
    const claimedDay = utcDayStart(snapshot.observedAt);
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO git_claim_thread_file_days (
        project_id, root_id, harness_id, thread_id, claimed_path, claimed_day
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.database.transaction(() => {
      for (const root of snapshot.roots) {
        for (const path of root.paths) {
          insert.run(snapshot.projectId, root.rootId, snapshot.harness, snapshot.threadId, path, claimedDay);
        }
      }
    })();
  }

  recordRateLimits(observation: WorkbenchRateLimitObservation) {
    this.database.transaction(() => {
      for (const snapshot of observation.snapshots) {
        const previousRows = this.database.prepare(`
          SELECT w.window_kind, w.used_basis_points, w.duration_minutes, w.resets_at
          FROM account_rate_limit_samples s
          LEFT JOIN account_rate_limit_windows w ON w.sample_id = s.id
          WHERE s.harness_id = ? AND s.limit_id = ?
            AND s.id = (SELECT id FROM account_rate_limit_samples WHERE harness_id = ? AND limit_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1)
        `).all(observation.harness, snapshot.limitId, observation.harness, snapshot.limitId) as Array<{
          duration_minutes: number | null; resets_at: number | null; used_basis_points: number | null;
          window_kind: "primary" | "secondary" | null;
        }>;
        const previous = (kind: "primary" | "secondary"): RateWindowObservation | null => {
          const row = previousRows.find((candidate) => candidate.window_kind === kind);
          return row?.used_basis_points === null || row?.used_basis_points === undefined ? null : {
            durationMinutes: row.duration_minutes,
            resetsAt: row.resets_at,
            usedPercent: row.used_basis_points / 100,
          };
        };
        const primary = snapshot.primary;
        const secondary = snapshot.secondary;
        if (previousRows.length && sameWindow(previous("primary"), primary) && sameWindow(previous("secondary"), secondary)) continue;
        const result = this.database.prepare(`
          INSERT INTO account_rate_limit_samples (harness_id, limit_id, limit_name, observed_at)
          VALUES (?, ?, ?, ?)
        `).run(observation.harness, snapshot.limitId, snapshot.limitName, observation.observedAt);
        const insertWindow = this.database.prepare(`
          INSERT INTO account_rate_limit_windows (
            sample_id, window_kind, used_basis_points, duration_minutes, resets_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const [kind, window] of [["primary", primary], ["secondary", secondary]] as const) {
          if (window) insertWindow.run(Number(result.lastInsertRowid), kind, Math.round(boundedPercent(window.usedPercent) * 100), window.durationMinutes, window.resetsAt);
        }
      }
    })();
  }

  read(request: WorkbenchStatsReadRequest, now = Date.now()): WorkbenchStatsResponse {
    const shape = bucketShape(request.range, now);
    const tokenBuckets = Array.from({ length: shape.count }, (_, index) => ({
      ...emptyTotals(),
      startedAt: shape.startedAt + index * shape.bucketMs,
    }));
    const costBuckets = tokenBuckets.map(({ startedAt }) => ({ startedAt, totalUsd: 0 }));
    const totals = emptyTotals();
    const basis = {
      defaultModelTokens: 0,
      exactModelTokens: 0,
      projectInferredModelTokens: 0,
      threadInferredModelTokens: 0,
    };
    const providers = new Set<WorkbenchHarness>();
    const models = new Set<string>();
    const selectedThreads = new Set<string>();
    let turnCount = 0;
    let totalUsd = 0;
    const modelRows = new Map<string, {
      costUsd: number; defaultModelTokens: number; inferredModelTokens: number; model: string;
      provider: WorkbenchHarness; threads: Set<string>; tokens: number;
    }>();
    const threadRows = new Map<string, {
      costUsd: number; models: Set<string>; projectId: string; providers: Set<WorkbenchHarness>;
      threadId: string; title: string; tokens: number;
    }>();
    const previousUsageByThread = new Map<string, WorkbenchCumulativeTokenUsage>();
    const tokenRows = this.database.prepare(`
      SELECT u.*, a.model attribution_model, a.source attribution_source,
        COALESCE(t.started_at, t.created_at) occurred_at, t.harness_id, t.turn_index,
        wt.id thread_id, wt.project_id, wt.title
      FROM thread_turn_usage u
      JOIN thread_turns t ON t.id = u.turn_id
      JOIN workbench_threads wt ON wt.id = t.thread_id
      LEFT JOIN thread_usage_model_attributions a ON a.turn_id = u.turn_id
      WHERE u.usage_data_version = ?
        AND (? IS NULL OR wt.project_id = ?)
      ORDER BY wt.id, t.turn_index
    `).all(WORKBENCH_STATS_USAGE_DATA_VERSION, request.projectId, request.projectId) as TokenRow[];
    for (const row of tokenRows) {
      const cumulative = cumulativeUsage(row);
      const previous = previousUsageByThread.get(row.thread_id) ?? null;
      previousUsageByThread.set(row.thread_id, cumulative);
      if (!previous && row.turn_index > 0) continue;
      const usage = usageDelta(cumulative, previous);
      if (row.occurred_at < shape.startedAt || row.occurred_at > now) continue;
      const effectiveModel = row.model || row.attribution_model || defaultApiPricingModel(row.harness_id);
      providers.add(row.harness_id);
      if (request.provider && row.harness_id !== request.provider) continue;
      models.add(effectiveModel);
      if (request.model && effectiveModel !== request.model) continue;
      const input = usage.inputTokens;
      const cachedInput = Math.min(input, usage.cachedInputTokens);
      const cacheWriteInput = Math.min(Math.max(0, input - cachedInput), usage.cacheWriteInputTokens);
      const uncachedInput = Math.max(0, input - cachedInput - cacheWriteInput);
      const output = usage.outputTokens;
      const all = input + output;
      const values = { all, cachedInput, cacheWriteInput, input, output, uncachedInput };
      const bucketPosition = bucketIndex(row.occurred_at, shape.startedAt, shape.bucketMs, shape.count);
      const bucket = tokenBuckets[bucketPosition]!;
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        totals[key] += values[key];
        bucket[key] += values[key];
      }
      const source = sourceFor(row);
      const estimate = estimateApiTokenCost({
        cacheWriteInputTokens: cacheWriteInput,
        cachedInputTokens: cachedInput,
        inputTokens: input,
        model: effectiveModel,
        modelSource: source,
        outputTokens: output,
        provider: row.harness_id,
        serviceTier: row.service_tier,
      });
      const basisKey = estimate.source === "exact"
        ? "exactModelTokens"
        : estimate.source === "default"
          ? "defaultModelTokens"
          : row.attribution_source === "project"
            ? "projectInferredModelTokens"
            : "threadInferredModelTokens";
      basis[basisKey] += all;
      totalUsd += estimate.totalUsd;
      costBuckets[bucketPosition]!.totalUsd += estimate.totalUsd;
      selectedThreads.add(row.thread_id);
      turnCount += 1;
      const modelKey = `${row.harness_id}\0${effectiveModel}`;
      const modelRow = modelRows.get(modelKey) ?? {
        costUsd: 0, defaultModelTokens: 0, inferredModelTokens: 0, model: effectiveModel,
        provider: row.harness_id, threads: new Set<string>(), tokens: 0,
      };
      modelRow.costUsd += estimate.totalUsd;
      modelRow.tokens += all;
      modelRow.threads.add(row.thread_id);
      if (estimate.source === "default") modelRow.defaultModelTokens += all;
      if (estimate.source === "inferred") modelRow.inferredModelTokens += all;
      modelRows.set(modelKey, modelRow);
      const threadRow = threadRows.get(row.thread_id) ?? {
        costUsd: 0, models: new Set<string>(), projectId: row.project_id, providers: new Set<WorkbenchHarness>(),
        threadId: row.thread_id, title: row.title, tokens: 0,
      };
      threadRow.costUsd += estimate.totalUsd;
      threadRow.models.add(effectiveModel);
      threadRow.providers.add(row.harness_id);
      threadRow.tokens += all;
      threadRows.set(row.thread_id, threadRow);
    }

    const claimHotspots = this.database.prepare(`
      SELECT project_id, root_id, claimed_path path, COUNT(DISTINCT harness_id || char(0) || thread_id) thread_count
      FROM git_claim_thread_file_days
      WHERE claimed_day BETWEEN ? AND ? AND (? IS NULL OR project_id = ?)
      GROUP BY project_id, root_id, claimed_path
      ORDER BY thread_count DESC, claimed_path
      LIMIT 20
    `).all(utcDayStart(shape.startedAt), utcDayStart(now), request.projectId, request.projectId) as Array<{
      path: string; project_id: string; root_id: string; thread_count: number;
    }>;

    const rateRows = this.database.prepare(`
      WITH selected AS (
        SELECT * FROM account_rate_limit_samples WHERE observed_at BETWEEN ? AND ?
        UNION
        SELECT prior.* FROM account_rate_limit_samples prior
        WHERE prior.observed_at < ? AND prior.observed_at = (
          SELECT MAX(candidate.observed_at) FROM account_rate_limit_samples candidate
          WHERE candidate.harness_id = prior.harness_id AND candidate.limit_id = prior.limit_id
            AND candidate.observed_at < ?
        )
      )
      SELECT s.*, w.window_kind, w.used_basis_points, w.duration_minutes, w.resets_at
      FROM selected s LEFT JOIN account_rate_limit_windows w ON w.sample_id = s.id
      ORDER BY s.observed_at, s.id
    `).all(shape.startedAt, now, shape.startedAt, shape.startedAt) as Array<{
      duration_minutes: number | null; harness_id: WorkbenchHarness; id: number; limit_id: string;
      limit_name: string | null; observed_at: number; resets_at: number | null;
      used_basis_points: number | null; window_kind: "primary" | "secondary" | null;
    }>;
    const rateSeries = new Map<string, WorkbenchStatsResponse["rateLimits"][number]>();
    for (const row of rateRows) {
      const key = `${row.harness_id}\0${row.limit_id}`;
      const series = rateSeries.get(key) ?? { harness: row.harness_id, limitId: row.limit_id, limitName: row.limit_name, samples: [] };
      if (!series.limitName && row.limit_name) series.limitName = row.limit_name;
      let sample = series.samples.find(({ observedAt }) => observedAt === row.observed_at);
      if (!sample) {
        sample = { observedAt: row.observed_at, primary: null, secondary: null };
        series.samples.push(sample);
      }
      if (row.window_kind && row.used_basis_points !== null) {
        sample[row.window_kind] = {
          durationMinutes: row.duration_minutes,
          resetsAt: row.resets_at,
          usedPercent: row.used_basis_points / 100,
        };
      }
      rateSeries.set(key, series);
    }

    return {
      bucketUnit: shape.bucketUnit,
      claimHotspots: claimHotspots.map((row) => ({
        path: row.path, projectId: row.project_id, rootId: row.root_id, threadCount: row.thread_count,
      })),
      cost: {
        basis,
        buckets: costBuckets.map((bucket) => ({ ...bucket, totalUsd: Number(bucket.totalUsd.toFixed(8)) })),
        totalUsd: Number(totalUsd.toFixed(8)),
      },
      failures: [],
      generatedAt: now,
      historyImport: EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS,
      models: [...modelRows.values()]
        .sort((left, right) => right.tokens - left.tokens || left.model.localeCompare(right.model))
        .map(({ threads, ...row }) => ({
          ...row, costUsd: Number(row.costUsd.toFixed(8)), threadCount: threads.size,
        })),
      pricingCatalogDate: API_PRICING_CATALOG_DATE,
      projectId: request.projectId,
      rateLimits: [...rateSeries.values()],
      range: request.range,
      startedAt: shape.startedAt,
      summary: {
        cacheHitPercent: totals.input ? boundedPercent(totals.cachedInput / totals.input * 100) : 0,
        threadCount: selectedThreads.size,
        turnCount,
      },
      tokens: { buckets: tokenBuckets, totals },
      topThreads: [...threadRows.values()]
        .sort((left, right) => right.tokens - left.tokens || left.title.localeCompare(right.title))
        .slice(0, 12)
        .map((row) => ({
          costUsd: Number(row.costUsd.toFixed(8)),
          models: [...row.models].sort(),
          projectId: row.projectId,
          providers: [...row.providers].sort(),
          sharePercent: totals.all ? boundedPercent(row.tokens / totals.all * 100) : 0,
          threadId: row.threadId,
          title: row.title,
          tokens: row.tokens,
        })),
      usageFilters: {
        models: [...models].sort(),
        providers: [...providers].sort(),
      },
      version: 2,
    };
  }
}
