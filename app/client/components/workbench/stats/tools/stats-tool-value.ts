/*
 * Exports:
 * - StatsToolSortKey/StatsToolSort: the tool table column and direction rows are ordered by.
 * - StatsToolValueRow: one wb tool's calls beside its always-on prompt cost and calls per 100 prompt tokens.
 * - statsToolValueRows: derive and order tool rows.
 * - summariseStatsTools: totals for the tools headline, including the tool tokens a thread carries without using.
 */
import type { WorkbenchStatsTools } from "workbench-shared/workbench/stats/workbench-stats-tools-contract";

export type StatsToolSortKey = "tool" | "calls" | "cost" | "value";
export interface StatsToolSort { key: StatsToolSortKey; descending: boolean }

type ToolRow = WorkbenchStatsTools["workbench"][number];

export interface StatsToolValueRow {
  readonly buckets: readonly number[];
  readonly bucketThreads: ToolRow["bucketThreads"];
  readonly calls: number;
  /** Spec plus docs tokens every turn carries for this tool. */
  readonly cost: number;
  readonly docsTokens: number;
  /** No served spec any more: calls from history only. */
  readonly retired: boolean;
  readonly specTokens: number;
  readonly threads: number;
  readonly tool: string;
  /** Calls per 100 prompt tokens; null when the tool costs nothing to carry. */
  readonly value: number | null;
}

function cost(row: ToolRow) {
  return (row.specTokens ?? 0) + row.docsTokens;
}

export function statsToolValueRows(tools: WorkbenchStatsTools, sort: StatsToolSort): StatsToolValueRow[] {
  const rows = tools.workbench.map((row): StatsToolValueRow => ({
    buckets: row.buckets, bucketThreads: row.bucketThreads, calls: row.calls, cost: cost(row), docsTokens: row.docsTokens,
    retired: row.specTokens === null, specTokens: row.specTokens ?? 0, threads: row.threads, tool: row.tool,
    value: cost(row) > 0 ? row.calls / cost(row) * 100 : null,
  }));
  const direction = sort.descending ? -1 : 1;
  const byName = (left: StatsToolValueRow, right: StatsToolValueRow) => left.tool.localeCompare(right.tool);
  const compare: Record<StatsToolSortKey, (left: StatsToolValueRow, right: StatsToolValueRow) => number> = {
    tool: (left, right) => direction * byName(left, right),
    calls: (left, right) => direction * (left.calls - right.calls) || byName(left, right),
    cost: (left, right) => direction * (left.cost - right.cost) || byName(left, right),
    // Free tools have no value to weigh, so they trail either way; among equal value the costlier tool is the bigger waste.
    value: (left, right) => {
      if (left.value === null || right.value === null) return (left.value === null ? 1 : 0) - (right.value === null ? 1 : 0) || byName(left, right);
      return direction * (left.value - right.value) || right.cost - left.cost || byName(left, right);
    },
  };
  return rows.sort(compare[sort.key]);
}

export function summariseStatsTools(tools: WorkbenchStatsTools) {
  const catalogued = tools.workbench.filter(({ specTokens }) => specTokens !== null);
  return {
    buckets: tools.bucketStarts.map((_, index) => tools.workbench.reduce((sum, row) => sum + (row.buckets[index] ?? 0), 0)),
    calls: tools.workbench.reduce((sum, row) => sum + row.calls, 0),
    catalogued: catalogued.length,
    idle: catalogued.filter(({ calls }) => !calls).length,
    /**
     * Each served tool's prompt cost times the share of active threads that never called it: the tool tokens an
     * average thread carries for nothing. Null until some thread called a wb tool.
     */
    wastePerThread: tools.threadCount
      ? catalogued.reduce((sum, row) => sum + cost(row) * (1 - Math.min(1, row.threads / tools.threadCount)), 0)
      : null,
  };
}
