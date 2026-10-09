/*
 * Keywords: stats, tools, calls, prompt cost, tokens, value.
 * Exports:
 * - WorkbenchStatsToolsSchema/WorkbenchStatsTools/EMPTY_WORKBENCH_STATS_TOOLS: the stats view's tools section; wb tool calls with their always-on prompt cost.
 */
import { z } from "zod";

const count = z.number().int().nonnegative();
const tokens = z.number().finite().nonnegative();
const timestamp = z.number().finite().nonnegative();
const MAX_BUCKETS = 90;
const MAX_BUCKET_THREADS = 3;

export const WorkbenchStatsToolsSchema = z.object({
  bucketStarts: z.array(timestamp).max(MAX_BUCKETS),
  /** Null when the tool catalogue or instruction sources could not be read; calls still count. */
  catalogue: z.object({
    docsTokens: tokens,
    specTokens: tokens,
    tools: count,
  }).strict().nullable(),
  /** Distinct threads that called any wb tool in the period. */
  threadCount: count.default(0),
  /** Threads named by `bucketThreads`, referenced by index. */
  threads: z.array(z.object({
    harness: z.string().min(1).nullable(),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    title: z.string().max(500),
  }).strict()).max(2_000).default([]),
  /** Every catalogued wb tool, used or not, plus retired names that still have calls. */
  workbench: z.array(z.object({
    calls: count,
    failed: count,
    threads: count,
    buckets: z.array(count).max(MAX_BUCKETS),
    /** Per bucket, the threads that called the tool most, largest first. */
    bucketThreads: z.array(z.array(z.object({ calls: count, thread: count }).strict()).max(MAX_BUCKET_THREADS)).max(MAX_BUCKETS).default([]),
    /** `<docs>` tokens charged to this tool; shared regions split evenly, so fractional. */
    docsTokens: tokens,
    /** Null for a tool that has calls but is no longer catalogued. */
    specTokens: tokens.nullable(),
    tool: z.string().min(1).max(200),
  }).strict()).max(300),
}).strict();
export type WorkbenchStatsTools = z.infer<typeof WorkbenchStatsToolsSchema>;

export const EMPTY_WORKBENCH_STATS_TOOLS: WorkbenchStatsTools = {
  bucketStarts: [], catalogue: null, threadCount: 0, threads: [], workbench: [],
};
