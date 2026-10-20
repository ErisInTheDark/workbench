/*
 * Exports:
 * - statsDataShape: how one stats section decomposes for observation deltas, so a reread ships only changed rows.
 */
import { z } from "zod";
import { observationShape } from "../workspace/observation-patch.ts";
import { WorkbenchStatsObservedResponseSchema } from "./workbench-stats-conformance.ts";

type Located = { daemonId?: string | null; projectId: string };
const item = z.json();
const at = (row: { startedAt: number }) => String(row.startedAt);
const thread = (row: Located & { threadId: string }) => `${row.daemonId ?? ""}/${row.projectId}/${row.threadId}`;
const buckets = observationShape.object({ fields: { buckets: observationShape.keyed(at, item) } });

/**
 * Sections carry disjoint fields, so one shape serves them all. Rows are loose here; the whole section
 * revalidates after each patch. A reread that only moves `generatedAt` publishes nothing.
 */
export const statsDataShape = observationShape.object({
  validate: WorkbenchStatsObservedResponseSchema,
  incidental: ["generatedAt"],
  fields: {
    rateLimits: observationShape.keyed(
      (limit: { harness: string; account?: { key: string } | null; limitId: string }) => `${limit.harness}/${limit.account?.key ?? ""}/${limit.limitId}`,
      item,
      { fields: { samples: observationShape.keyed((sample: { observedAt: number }) => String(sample.observedAt), item) } },
    ),
    cacheEfficiency: observationShape.object({ fields: {
      buckets: observationShape.keyed(at, item),
      worstThreads: observationShape.keyed(thread, item),
    } }),
    cost: observationShape.object({ fields: {
      buckets: observationShape.keyed(at, item),
      unpricedModels: observationShape.keyed((row: { provider: string; model: string | null }) => `${row.provider}/${row.model ?? ""}`, item),
    } }),
    models: observationShape.keyed((row: { provider: string; model: string | null }) => `${row.provider}/${row.model ?? ""}`, item),
    projects: observationShape.keyed((row: Located) => `${row.daemonId ?? ""}/${row.projectId}`, item),
    providers: observationShape.keyed((row: { provider: string }) => row.provider, item),
    summary: buckets,
    tokens: buckets,
    topThreads: observationShape.keyed(thread, item),
    claimHotspots: observationShape.keyed(
      (row: Located & { rootId: string; path: string }) => `${row.daemonId ?? ""}/${row.projectId}/${row.rootId}/${row.path}`, item),
    tools: observationShape.object({ fields: {
      threads: observationShape.keyed(thread, item),
      workbench: observationShape.keyed((row: { tool: string }) => row.tool, item),
    } }),
    feedback: observationShape.object({ fields: {
      items: observationShape.keyed((row: { daemonId?: string | null; id: number }) => `${row.daemonId ?? ""}/${row.id}`, item),
      resolved: observationShape.keyed((row: { daemonId?: string | null; id: number }) => `${row.daemonId ?? ""}/${row.id}`, item),
    } }),
  },
});
