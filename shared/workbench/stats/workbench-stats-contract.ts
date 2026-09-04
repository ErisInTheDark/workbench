/*
 * Exports:
 * - WorkbenchStatsRangeSchema/WorkbenchStatsRange: bounded selectable stats windows. Keywords: stats, range, contract.
 * - WorkbenchStatsReadRequestSchema/WorkbenchStatsReadRequest: scoped and filtered stats request. Keywords: stats, request, filters.
 * - WorkbenchStatsImportProgressSchema/WorkbenchStatsImportProgress: split usage and Git history import progress. Keywords: stats, import, progress.
 * - WorkbenchStatsHydrationResultSchema/WorkbenchStatsHydrationResult: one harness hydration result. Keywords: stats, import, harness.
 * - WORKBENCH_STATS_IMPORT_UPDATED_METHOD: pushed import progress notification method. Keywords: stats, websocket, progress.
 * - WorkbenchStatsResponseSchema/WorkbenchStatsResponse: normalized token, cost, driver, limit, and claim aggregates. Keywords: stats, usage, claims.
 */
import { z } from "zod";

const finiteNonNegative = z.number().finite().nonnegative();
const timestamp = z.number().finite().nonnegative();
const boundedText = z.string().max(500);
const count = z.number().int().nonnegative();
const harness = z.enum(["codex", "copilot", "opencode"]);
const MAX_GRAPH_BUCKETS = 90;

export const WORKBENCH_STATS_IMPORT_UPDATED_METHOD = "workbench/stats/import/updated";

const ImportSourceProgressSchema = z.object({
  completed: count,
  failed: count,
  processed: count,
  total: count,
  unavailable: count,
}).strict();

const StatsImportFailureSchema = z.object({
  harness: z.string().min(1).nullable(),
  message: boundedText,
  source: z.enum(["claims", "usage"]),
  subject: z.string().min(1).max(2_000),
}).strict();

const StatsImportProgressV2Schema = z.object({
  claims: ImportSourceProgressSchema,
  percent: finiteNonNegative.max(100),
  recentFailures: z.array(StatsImportFailureSchema).max(20),
  revision: count,
  state: z.enum(["idle", "running", "complete"]),
  unsupportedClaimCheckpoints: count,
  usage: ImportSourceProgressSchema,
  version: z.literal(2),
}).strict();

const LegacyImportProgressSchema = z.object({
  completedThreads: count,
  failedThreads: count,
  percent: finiteNonNegative.max(100),
  processedThreads: count,
  recentFailures: z.array(z.object({
    harness: z.string().min(1),
    message: boundedText,
    threadId: z.string().min(1),
  }).strict()).max(20),
  revision: count,
  state: z.enum(["idle", "running", "complete"]),
  totalThreads: count,
  unavailableThreads: count,
}).strict();

function emptyImportSource() {
  return { completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 };
}

export const WorkbenchStatsImportProgressSchema = z.union([
  StatsImportProgressV2Schema,
  LegacyImportProgressSchema.transform((legacy) => ({
    claims: emptyImportSource(),
    percent: legacy.percent,
    recentFailures: legacy.recentFailures.map((failure) => ({
      harness: failure.harness,
      message: failure.message,
      source: "usage" as const,
      subject: failure.threadId,
    })),
    revision: legacy.revision,
    state: legacy.state,
    unsupportedClaimCheckpoints: 0,
    usage: {
      completed: legacy.completedThreads,
      failed: legacy.failedThreads,
      processed: legacy.processedThreads,
      total: legacy.totalThreads,
      unavailable: legacy.unavailableThreads,
    },
    version: 2 as const,
  })),
]);
export type WorkbenchStatsImportProgress = z.infer<typeof StatsImportProgressV2Schema>;

export const EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS: WorkbenchStatsImportProgress = {
  claims: emptyImportSource(),
  percent: 100,
  recentFailures: [],
  revision: 0,
  state: "idle",
  unsupportedClaimCheckpoints: 0,
  usage: emptyImportSource(),
  version: 2,
};

export const WorkbenchStatsHydrationResultSchema = z.object({
  state: z.enum(["completed", "unavailable"]),
}).strict();
export type WorkbenchStatsHydrationResult = z.infer<typeof WorkbenchStatsHydrationResultSchema>;

export const WorkbenchStatsRangeSchema = z.enum(["7d", "14d", "30d", "90d", "365d"]);
export type WorkbenchStatsRange = z.infer<typeof WorkbenchStatsRangeSchema>;

export const WorkbenchStatsReadRequestSchema = z.object({
  model: z.string().trim().min(1).max(200).nullable().default(null),
  projectId: z.string().min(1).nullable(),
  provider: harness.nullable().default(null),
  range: WorkbenchStatsRangeSchema,
}).strict();
export type WorkbenchStatsReadRequest = z.input<typeof WorkbenchStatsReadRequestSchema>;

const TokenTotalsSchema = z.object({
  all: finiteNonNegative,
  cachedInput: finiteNonNegative,
  cacheWriteInput: finiteNonNegative,
  input: finiteNonNegative,
  output: finiteNonNegative,
  uncachedInput: finiteNonNegative,
}).strict();
const TokenBucketSchema = TokenTotalsSchema.extend({ startedAt: timestamp }).strict();
const CostBucketSchema = z.object({ startedAt: timestamp, totalUsd: finiteNonNegative }).strict();
const CostBasisSchema = z.object({
  defaultModelTokens: finiteNonNegative,
  exactModelTokens: finiteNonNegative,
  projectInferredModelTokens: finiteNonNegative,
  threadInferredModelTokens: finiteNonNegative,
}).strict();
const RateWindowSchema = z.object({
  durationMinutes: finiteNonNegative.nullable(),
  resetsAt: timestamp.nullable(),
  usedPercent: finiteNonNegative.max(100),
}).strict();

const StatsResponseV2Schema = z.object({
  bucketUnit: z.enum(["day", "week"]),
  claimHotspots: z.array(z.object({
    path: z.string().min(1).max(2_000),
    projectId: z.string().min(1),
    rootId: z.string().min(1),
    threadCount: count,
  }).strict()).max(20),
  cost: z.object({
    basis: CostBasisSchema,
    buckets: z.array(CostBucketSchema).max(MAX_GRAPH_BUCKETS),
    totalUsd: finiteNonNegative,
  }).strict(),
  failures: z.array(z.object({
    harness: z.string().min(1).nullable(),
    message: boundedText,
    source: z.enum(["capture", "refresh"]),
  }).strict()).max(20),
  generatedAt: timestamp,
  historyImport: WorkbenchStatsImportProgressSchema.default(() => ({ ...EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS })),
  models: z.array(z.object({
    costUsd: finiteNonNegative,
    defaultModelTokens: finiteNonNegative,
    inferredModelTokens: finiteNonNegative,
    model: z.string().min(1).max(200),
    provider: harness,
    threadCount: count,
    tokens: finiteNonNegative,
  }).strict()).max(100),
  pricingCatalogDate: z.iso.date(),
  projectId: z.string().min(1).nullable(),
  rateLimits: z.array(z.object({
    harness,
    limitId: z.string().min(1),
    limitName: z.string().nullable(),
    samples: z.array(z.object({
      observedAt: timestamp,
      primary: RateWindowSchema.nullable(),
      secondary: RateWindowSchema.nullable(),
    }).strict()).max(2_000),
  }).strict()).max(100),
  range: WorkbenchStatsRangeSchema,
  startedAt: timestamp,
  summary: z.object({
    cacheHitPercent: finiteNonNegative.max(100),
    threadCount: count,
    turnCount: count,
  }).strict(),
  tokens: z.object({
    buckets: z.array(TokenBucketSchema).max(MAX_GRAPH_BUCKETS),
    totals: TokenTotalsSchema,
  }).strict(),
  topThreads: z.array(z.object({
    costUsd: finiteNonNegative,
    models: z.array(z.string().min(1).max(200)).max(20),
    projectId: z.string().min(1),
    providers: z.array(harness).max(3),
    sharePercent: finiteNonNegative.max(100),
    threadId: z.string().min(1),
    title: z.string().max(500),
    tokens: finiteNonNegative,
  }).strict()).max(12),
  usageFilters: z.object({
    models: z.array(z.string().min(1).max(200)).max(100),
    providers: z.array(harness).max(3),
  }).strict(),
  version: z.literal(2),
}).strict();

const LegacyTokenTotalsSchema = z.object({
  all: finiteNonNegative,
  cachedInput: finiteNonNegative,
  input: finiteNonNegative,
  output: finiteNonNegative,
}).strict();
const LegacyStatsResponseSchema = z.object({
  bucketUnit: z.enum(["day", "week"]),
  claimHotspots: z.array(z.object({
    buckets: z.array(z.object({ busyMs: finiteNonNegative, startedAt: timestamp }).strict()).max(MAX_GRAPH_BUCKETS),
    busyMs: finiteNonNegative,
    busyPercent: finiteNonNegative.max(100),
    claimCount: count,
    claimedNow: z.boolean(),
    path: z.string().min(1).max(2_000),
    projectId: z.string().min(1),
    rootId: z.string().min(1),
    threadCount: count,
  }).strict()).max(20),
  cost: z.object({
    buckets: z.array(CostBucketSchema).max(MAX_GRAPH_BUCKETS),
    pricedTokens: finiteNonNegative,
    totalUsd: finiteNonNegative,
    unpricedTokens: finiteNonNegative,
  }).strict(),
  failures: StatsResponseV2Schema.shape.failures,
  generatedAt: timestamp,
  historyImport: WorkbenchStatsImportProgressSchema.default(() => ({ ...EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS })),
  pricingCatalogDate: z.iso.date(),
  projectId: z.string().min(1).nullable(),
  providerAvailability: z.array(z.object({}).passthrough()).default([]),
  rateLimits: StatsResponseV2Schema.shape.rateLimits,
  range: WorkbenchStatsRangeSchema,
  recordingStartedAt: timestamp.nullable(),
  startedAt: timestamp,
  tokens: z.object({
    buckets: z.array(LegacyTokenTotalsSchema.extend({ startedAt: timestamp }).strict()).max(MAX_GRAPH_BUCKETS),
    totals: LegacyTokenTotalsSchema,
  }).strict(),
}).strict();

function normalizeLegacyTokens(value: z.infer<typeof LegacyTokenTotalsSchema>) {
  return {
    ...value,
    cacheWriteInput: 0,
    uncachedInput: Math.max(0, value.input - value.cachedInput),
  };
}

export const WorkbenchStatsResponseSchema = z.union([
  StatsResponseV2Schema,
  LegacyStatsResponseSchema.transform((legacy) => ({
    bucketUnit: legacy.bucketUnit,
    claimHotspots: legacy.claimHotspots.map(({ path, projectId, rootId, threadCount }) => ({
      path, projectId, rootId, threadCount,
    })),
    cost: {
      basis: {
        defaultModelTokens: legacy.cost.unpricedTokens,
        exactModelTokens: legacy.cost.pricedTokens,
        projectInferredModelTokens: 0,
        threadInferredModelTokens: 0,
      },
      buckets: legacy.cost.buckets,
      totalUsd: legacy.cost.totalUsd,
    },
    failures: legacy.failures,
    generatedAt: legacy.generatedAt,
    historyImport: legacy.historyImport,
    models: [],
    pricingCatalogDate: legacy.pricingCatalogDate,
    projectId: legacy.projectId,
    rateLimits: legacy.rateLimits,
    range: legacy.range,
    startedAt: legacy.startedAt,
    summary: { cacheHitPercent: 0, threadCount: 0, turnCount: 0 },
    tokens: {
      buckets: legacy.tokens.buckets.map((bucket) => ({
        ...normalizeLegacyTokens(bucket),
        startedAt: bucket.startedAt,
      })),
      totals: normalizeLegacyTokens(legacy.tokens.totals),
    },
    topThreads: [],
    usageFilters: { models: [], providers: [] },
    version: 2 as const,
  })),
]);
export type WorkbenchStatsResponse = z.infer<typeof StatsResponseV2Schema>;
