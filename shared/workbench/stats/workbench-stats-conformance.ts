/*
 * Exports:
 * - EMPTY_WORKBENCH_STATS_RESPONSE: a valid response with no usage, the fallback for unrepairable nodes.
 * - WorkbenchStatsObservedResponseSchema: stats responses that repair cross-version drift instead of rejecting a whole revision.
 */
import { z } from "zod";
import reportClientSchemaError from "../report-client-schema-error.ts";
import { conformToZodSchema } from "../zod-schema-conformer.ts";
import {
  EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS,
  WorkbenchStatsResponseSchema,
  type WorkbenchStatsResponse,
} from "./workbench-stats-contract.ts";

const noCosts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const noTokens = { all: 0, cachedInput: 0, cacheWriteInput: 0, input: 0, output: 0, uncachedInput: 0 };

export const EMPTY_WORKBENCH_STATS_RESPONSE: WorkbenchStatsResponse = {
  bucketUnit: "day",
  cacheEfficiency: { buckets: [], totals: { cacheHitPercent: null, cachedInputTokens: 0, inputTokens: 0 }, worstThreads: [] },
  claimHotspots: [],
  cost: {
    basis: { exactModelTokens: 0, projectInferredModelTokens: 0, threadInferredModelTokens: 0, unpricedTokens: 0 },
    buckets: [], byTokenType: noCosts, totalUsd: 0, unpricedModels: [],
  },
  failures: [],
  generatedAt: 0,
  historyImport: EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS,
  models: [],
  previous: { costUsd: 0, threadCount: 0, tokens: 0, turnCount: 0 },
  pricingCatalogDate: "1970-01-01",
  projectIds: null,
  projects: [],
  providers: [],
  range: "7d",
  rateLimits: [],
  startedAt: 0,
  summary: { buckets: [], threadCount: 0, turnCount: 0 },
  tokens: { buckets: [], totals: noTokens },
  topThreads: [],
  usageFilters: { models: [], providers: [] },
  version: 3,
};

// Every streamed revision repeats the same drift, so each distinct mismatch is reported once per process.
const reported = new Set<string>();

/**
 * Stats revisions cross daemon, app server and tab reloads independently. A revision from a newer or older
 * owner is repaired (unknown keys dropped, broken nodes reset) and still shown rather than rejected.
 */
export const WorkbenchStatsObservedResponseSchema = z.preprocess((value) => {
  const parsed = WorkbenchStatsResponseSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Array indexes vary per row; the drift is the same shape at every index.
  const signature = parsed.error.issues.map(({ code, path }) => `${code}:${path.filter((part) => typeof part !== "number").join(".")}`)
    .sort().join("|");
  if (!reported.has(signature)) {
    reported.add(signature);
    reportClientSchemaError("Repaired mismatched Workbench stats revision", parsed.error);
  }
  return conformToZodSchema(WorkbenchStatsResponseSchema, value, EMPTY_WORKBENCH_STATS_RESPONSE).data;
}, WorkbenchStatsResponseSchema);
