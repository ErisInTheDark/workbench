/*
 * Exports:
 * - EMPTY_WORKBENCH_STATS_SECTIONS: a valid, empty value per section, the fallback for unrepairable nodes.
 * - WorkbenchStatsObservedResponseSchema: stats sections that repair cross-version drift instead of rejecting a whole revision.
 */
import { z } from "zod";
import reportClientSchemaError from "../report-client-schema-error.ts";
import { conformToZodSchema } from "../zod-schema-conformer.ts";
import {
  EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS,
  WorkbenchStatsResponseSchema,
  WorkbenchStatsSectionSchema,
  WorkbenchStatsSectionSchemas,
  type WorkbenchStatsResponse,
  type WorkbenchStatsSection,
  type WorkbenchStatsSectionData,
} from "./workbench-stats-contract.ts";
import { EMPTY_WORKBENCH_STATS_FEEDBACK } from "./workbench-stats-feedback-contract.ts";
import { EMPTY_WORKBENCH_STATS_TOOLS } from "./workbench-stats-tools-contract.ts";

const noCosts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const noTokens = { all: 0, cachedInput: 0, cacheWriteInput: 0, input: 0, output: 0, uncachedInput: 0 };

export const EMPTY_WORKBENCH_STATS_SECTIONS: { [Section in WorkbenchStatsSection]: WorkbenchStatsSectionData<Section> } = {
  usage: {
    section: "usage",
    bucketUnit: "day",
    cacheEfficiency: { buckets: [], totals: { cacheHitPercent: null, cachedInputTokens: 0, inputTokens: 0 }, worstThreads: [] },
    cost: {
      basis: { exactModelTokens: 0, projectInferredModelTokens: 0, threadInferredModelTokens: 0, unpricedTokens: 0 },
      buckets: [], byTokenType: noCosts, totalUsd: 0, unpricedModels: [],
    },
    generatedAt: 0,
    models: [],
    previous: { costUsd: 0, threadCount: 0, tokens: 0, turnCount: 0 },
    pricingCatalogDate: "1970-01-01",
    projectIds: null,
    projects: [],
    providers: [],
    range: "7d",
    startedAt: 0,
    summary: { buckets: [], threadCount: 0, turnCount: 0 },
    tokens: { buckets: [], totals: noTokens },
    topThreads: [],
    usageFilters: { models: [], providers: [] },
  },
  limits: { section: "limits", generatedAt: 0, rateLimits: [] },
  claims: { section: "claims", generatedAt: 0, claimHotspots: [], historyFailures: [] },
  feedback: { section: "feedback", generatedAt: 0, feedback: EMPTY_WORKBENCH_STATS_FEEDBACK },
  tools: { section: "tools", generatedAt: 0, tools: EMPTY_WORKBENCH_STATS_TOOLS },
  status: { section: "status", generatedAt: 0, failures: [], historyImport: EMPTY_WORKBENCH_STATS_IMPORT_PROGRESS },
};

// Every streamed revision repeats the same drift, so each distinct mismatch is reported once per process.
const reported = new Set<string>();

function repair(value: unknown): WorkbenchStatsResponse | unknown {
  const parsed = WorkbenchStatsResponseSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  // Without a known section there is nothing to repair towards; the union rejects it.
  const section = WorkbenchStatsSectionSchema.safeParse((value as { section?: unknown } | null)?.section);
  if (!section.success) return value;
  // Array indexes vary per row; the drift is the same shape at every index.
  const signature = `${section.data}:${parsed.error.issues
    .map(({ code, path }) => `${code}:${path.filter((part) => typeof part !== "number").join(".")}`).sort().join("|")}`;
  if (!reported.has(signature)) {
    reported.add(signature);
    reportClientSchemaError("Repaired mismatched Workbench stats revision", parsed.error);
  }
  const schema: z.ZodType = WorkbenchStatsSectionSchemas[section.data];
  return conformToZodSchema(schema, value, EMPTY_WORKBENCH_STATS_SECTIONS[section.data]).data;
}

/**
 * Stats revisions cross daemon, app server and tab reloads independently. A section from a newer or older
 * owner is repaired (unknown keys dropped, broken nodes reset) and still shown rather than rejected.
 */
export const WorkbenchStatsObservedResponseSchema = z.preprocess(repair, WorkbenchStatsResponseSchema);
