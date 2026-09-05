/*
 * Keywords: stats, claims, files, threads, pagination.
 * Exports:
 * - WorkbenchClaimStatsRangeSchema: supported UTC windows, including all retained history.
 * - WorkbenchClaimStatsRequest/WorkbenchClaimStatsResponse: trusted sqlite query and compact result.
 * - WORKBENCH_CLAIM_STATS_PAGE_SIZE: bounded rows per CLI page.
 */
import { z } from "zod";
import type { WorkbenchHarness } from "../../types.ts";
import { WorkbenchStatsRangeSchema } from "./workbench-stats-contract.ts";

export const WorkbenchClaimStatsRangeSchema = z.union([WorkbenchStatsRangeSchema, z.literal("all")]);
export const WORKBENCH_CLAIM_STATS_PAGE_SIZE = 50;
export interface WorkbenchClaimStatsRequest {
  projectId: string;
  file: { rootId: string; path: string } | null;
  range: z.infer<typeof WorkbenchClaimStatsRangeSchema>;
  page: number;
}
export type WorkbenchClaimStatsResponse = {
  page: number;
  pages: number;
} & ({
  kind: "files";
  rows: Array<{ rootId: string; path: string; threadCount: number }>;
} | {
  kind: "threads";
  rows: Array<{ threadId: string; title: string | null; harness: WorkbenchHarness; identity: "managed" | "provider" }>;
});
