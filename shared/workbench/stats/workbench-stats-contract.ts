/*
 * Exports:
 * - WORKBENCH_STATS_IMPORT_UPDATED_METHOD: pushed import progress notification method.
 * - WorkbenchStatsImportProgressSchema/WorkbenchStatsImportProgress: split usage and Git history import progress.
 * - EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS: idle progress before any import ran.
 * - WorkbenchStatsHydrationResultSchema/WorkbenchStatsHydrationResult: one harness hydration result.
 * - WorkbenchStatsRangeSchema/WorkbenchStatsRange: bounded selectable stats windows.
 * - STATS_TOKEN_TYPES/StatsTokenType: independently selectable billing categories.
 * - WORKBENCH_STATS_SECTIONS/WorkbenchStatsSectionSchema/WorkbenchStatsSection: independently observed parts of the stats view.
 * - WorkbenchStatsReadRequestSchema/WorkbenchStatsReadRequest: one section of a project-scoped, filtered stats request.
 * - WorkbenchStatsSectionSchemas/WorkbenchStatsResponseSchema/WorkbenchStatsResponse/WorkbenchStatsSectionData: one section's data: usage, limits, claims, feedback, tools, or status.
 * - statsRangeShape: shared UTC day/week window boundaries.
 * - statsPeriodShape: a range's buckets narrowed to a selected period.
 */
import { z } from "zod";
import { ProviderKeySchema as harness } from "../provider/provider-key.ts";
import { StatsCacheEfficiencySchema } from "./workbench-stats-cache-contract.ts";
import { WorkbenchStatsFeedbackSchema } from "./workbench-stats-feedback-contract.ts";
import { WorkbenchStatsToolsSchema } from "./workbench-stats-tools-contract.ts";

const finiteNonNegative = z.number().finite().nonnegative();
const timestamp = z.number().finite().nonnegative();
const boundedText = z.string().max(500);
const count = z.number().int().nonnegative();
const modelName = z.string().min(1).max(200);
const MAX_GRAPH_BUCKETS = 90;

export const WORKBENCH_STATS_IMPORT_UPDATED_METHOD = "workbench/stats/import/updated";

const ImportSourceProgressSchema = z.object({
  completed: count,
  failed: count,
  processed: count,
  total: count,
  unavailable: count,
}).strict();

export const WorkbenchStatsImportProgressSchema = z.object({
  claims: ImportSourceProgressSchema,
  percent: finiteNonNegative.max(100),
  recentFailures: z.array(z.object({
    harness: z.string().min(1).nullable(),
    message: boundedText,
    source: z.enum(["claims", "usage"]),
    subject: z.string().min(1).max(2_000),
  }).strict()).max(20),
  revision: count,
  state: z.enum(["idle", "running", "complete"]),
  unsupportedClaimCheckpoints: count,
  usage: ImportSourceProgressSchema,
  version: z.literal(2),
}).strict();
export type WorkbenchStatsImportProgress = z.infer<typeof WorkbenchStatsImportProgressSchema>;

const emptyImportSource = () => ({ completed: 0, failed: 0, processed: 0, total: 0, unavailable: 0 });
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

export const STATS_TOKEN_TYPES = ["input", "cacheRead", "cacheWrite", "output"] as const;
export type StatsTokenType = typeof STATS_TOKEN_TYPES[number];

/** Older browsers sent one combined "cache" category; it now means both cache reads and writes. */
const StatsTokenTypesSchema = z.preprocess(
  (value) => Array.isArray(value) ? [...new Set(value.flatMap((type) => type === "cache" ? ["cacheRead", "cacheWrite"] : [type]))] : value,
  z.array(z.enum(STATS_TOKEN_TYPES)).max(STATS_TOKEN_TYPES.length),
);

export const WORKBENCH_STATS_SECTIONS = ["usage", "limits", "claims", "feedback", "tools", "status"] as const;
export const WorkbenchStatsSectionSchema = z.enum(WORKBENCH_STATS_SECTIONS);
export type WorkbenchStatsSection = z.infer<typeof WorkbenchStatsSectionSchema>;

/** Provider, model and token-type filters narrow usage only; every other section follows scope, range and period. */
export const WorkbenchStatsReadRequestSchema = z.object({
  model: z.string().trim().min(1).max(200).nullable().default(null),
  /**
   * Narrows every figure to the buckets starting between these two bucket starts, inclusive.
   * Null reads the whole range.
   */
  period: z.object({ from: timestamp, to: timestamp }).strict().refine(({ from, to }) => from <= to).nullable().default(null),
  /** Null reads every project on the daemon; an empty list reads nothing. */
  projectIds: z.array(z.string().min(1)).max(500).nullable(),
  provider: harness.nullable().default(null),
  range: WorkbenchStatsRangeSchema,
  section: WorkbenchStatsSectionSchema,
  tokenTypes: StatsTokenTypesSchema.default(() => [...STATS_TOKEN_TYPES]),
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
const CategoryCostsSchema = z.object({
  input: finiteNonNegative, cacheRead: finiteNonNegative, cacheWrite: finiteNonNegative, output: finiteNonNegative,
}).strict();
const RateWindowSchema = z.object({
  durationMinutes: finiteNonNegative.nullable(),
  resetsAt: timestamp.nullable(),
  usedPercent: finiteNonNegative.max(100),
}).strict();
/** Unpriced tokens count toward token totals but never toward any cost. */
const UsageShareSchema = {
  costUsd: finiteNonNegative,
  threadCount: count,
  tokens: finiteNonNegative,
  unpricedTokens: finiteNonNegative,
};
const section = <Name extends WorkbenchStatsSection, Shape extends z.ZodRawShape>(name: Name, shape: Shape) =>
  z.object({ ...shape, generatedAt: timestamp, section: z.literal(name) }).strict();

const UsageSectionSchema = section("usage", {
  bucketUnit: z.enum(["day", "week"]),
  cacheEfficiency: StatsCacheEfficiencySchema,
  cost: z.object({
    basis: z.object({
      exactModelTokens: finiteNonNegative,
      projectInferredModelTokens: finiteNonNegative,
      threadInferredModelTokens: finiteNonNegative,
      unpricedTokens: finiteNonNegative,
    }).strict(),
    buckets: z.array(z.object({ byTokenType: CategoryCostsSchema, startedAt: timestamp, totalUsd: finiteNonNegative }).strict()).max(MAX_GRAPH_BUCKETS),
    byTokenType: CategoryCostsSchema,
    totalUsd: finiteNonNegative,
    unpricedModels: z.array(z.object({ model: modelName.nullable(), provider: harness, tokens: finiteNonNegative }).strict()).max(50),
  }).strict(),
  models: z.array(z.object({
    ...UsageShareSchema,
    inferredModelTokens: finiteNonNegative,
    model: modelName.nullable(),
    provider: harness,
  }).strict()).max(100),
  previous: z.object({ costUsd: finiteNonNegative, threadCount: count, tokens: finiteNonNegative, turnCount: count }).strict(),
  pricingCatalogDate: z.iso.date(),
  projectIds: z.array(z.string().min(1)).nullable(),
  projects: z.array(z.object({ ...UsageShareSchema, projectId: z.string().min(1) }).strict()).max(100),
  providers: z.array(z.object({ ...UsageShareSchema, provider: harness }).strict()).max(10),
  range: WorkbenchStatsRangeSchema,
  startedAt: timestamp,
  summary: z.object({
    buckets: z.array(z.object({ startedAt: timestamp, threadCount: count, turnCount: count }).strict()).max(MAX_GRAPH_BUCKETS).default([]),
    threadCount: count,
    turnCount: count,
  }).strict(),
  tokens: z.object({
    buckets: z.array(TokenTotalsSchema.extend({ startedAt: timestamp }).strict()).max(MAX_GRAPH_BUCKETS),
    totals: TokenTotalsSchema,
  }).strict(),
  topThreads: z.array(z.object({
    costUsd: finiteNonNegative,
    tokens: finiteNonNegative,
    unpricedTokens: finiteNonNegative,
    models: z.array(modelName).max(20),
    /** Per-model split of this thread's usage, largest first. */
    modelShares: z.array(z.object({
      costUsd: finiteNonNegative,
      model: modelName.nullable(),
      provider: harness,
      tokens: finiteNonNegative,
      unpricedTokens: finiteNonNegative,
    }).strict()).max(20).default([]),
    /** The provider the thread started on, which identifies it alongside its id. */
    harness: harness.nullable().default(null),
    projectId: z.string().min(1),
    providers: z.array(harness).max(10),
    sharePercent: finiteNonNegative.max(100),
    threadId: z.string().min(1),
    title: z.string().max(500),
  }).strict()).max(12),
  usageFilters: z.object({
    models: z.array(modelName).max(100),
    providers: z.array(harness).max(10),
  }).strict(),
});

/** Plan limits are account-wide and current, so they ignore scope and period and always span the whole range. */
const LimitsSectionSchema = section("limits", {
  rateLimits: z.array(z.object({
    harness,
    limitId: z.string().min(1),
    limitName: z.string().nullable(),
    samples: z.array(z.object({
      observedAt: timestamp,
      primary: RateWindowSchema.nullable(),
      secondary: RateWindowSchema.nullable(),
      tertiary: RateWindowSchema.nullable(),
    }).strict()).max(2_000),
  }).strict()).max(100),
});

const ClaimsSectionSchema = section("claims", {
  claimHotspots: z.array(z.object({
    path: z.string().min(1).max(2_000),
    projectId: z.string().min(1),
    rootId: z.string().min(1),
    threadCount: count,
    /** Claiming threads, largest lifetime token use first. */
    threads: z.array(z.object({
      harness: harness.nullable().default(null),
      /** Null for provider threads Workbench cannot open. */
      threadId: z.string().min(1).nullable().default(null),
      title: z.string().max(500).nullable(),
      tokens: finiteNonNegative,
    }).strict()).max(12).default([]),
  }).strict()).max(20),
  /** Committed rename history that could not be read, so renamed files may still count apart. */
  historyFailures: z.array(boundedText).max(20),
});

/** Agent friction reports in the selected projects and period. */
const FeedbackSectionSchema = section("feedback", { feedback: WorkbenchStatsFeedbackSchema });

const ToolsSectionSchema = section("tools", { tools: WorkbenchStatsToolsSchema });

/** Import progress and capture failures are daemon-wide. */
const StatusSectionSchema = section("status", {
  failures: z.array(z.object({
    harness: z.string().min(1).nullable(),
    message: boundedText,
    source: z.enum(["capture", "refresh"]),
  }).strict()).max(20),
  historyImport: WorkbenchStatsImportProgressSchema,
});

export const WorkbenchStatsSectionSchemas = {
  claims: ClaimsSectionSchema,
  feedback: FeedbackSectionSchema,
  limits: LimitsSectionSchema,
  status: StatusSectionSchema,
  tools: ToolsSectionSchema,
  usage: UsageSectionSchema,
} as const satisfies Record<WorkbenchStatsSection, z.ZodObject>;

export const WorkbenchStatsResponseSchema = z.discriminatedUnion("section", [
  UsageSectionSchema, LimitsSectionSchema, ClaimsSectionSchema, FeedbackSectionSchema, ToolsSectionSchema, StatusSectionSchema,
]);
export type WorkbenchStatsResponse = z.infer<typeof WorkbenchStatsResponseSchema>;
export type WorkbenchStatsSectionData<Section extends WorkbenchStatsSection> = Extract<WorkbenchStatsResponse, { section: Section }>;

export function statsRangeShape(range: WorkbenchStatsRange, now: number) {
  const day = 86_400_000;
  const currentDay = Math.floor(now / day) * day;
  if (range !== "365d") {
    const count = { "7d": 7, "14d": 14, "30d": 30, "90d": 90 }[range];
    return { bucketMs: day, bucketUnit: "day" as const, count, startedAt: currentDay - (count - 1) * day };
  }
  const monday = currentDay - ((new Date(currentDay).getUTCDay() + 6) % 7) * day;
  return { bucketMs: 7 * day, bucketUnit: "week" as const, count: 53, startedAt: monday - 52 * 7 * day };
}

/**
 * The range's buckets, narrowed to a selected period. `endedAt` is exclusive.
 * A period that no longer overlaps the range (the window moved on) selects zero buckets.
 */
export function statsPeriodShape(range: WorkbenchStatsRange, period: { from: number; to: number } | null, now: number) {
  const shape = statsRangeShape(range, now);
  if (!period) return { ...shape, endedAt: shape.startedAt + shape.count * shape.bucketMs };
  const first = Math.max(0, Math.ceil((period.from - shape.startedAt) / shape.bucketMs));
  const last = Math.min(shape.count - 1, Math.floor((period.to - shape.startedAt) / shape.bucketMs));
  const count = Math.max(0, last - first + 1);
  const startedAt = shape.startedAt + first * shape.bucketMs;
  return { ...shape, count, startedAt, endedAt: startedAt + count * shape.bucketMs };
}
