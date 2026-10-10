/*
 * Exports:
 * - WORKBENCH_TOOL_SERVERS: MCP server names that serve wb tools across providers.
 * - default WorkbenchToolStatsRepository: merge live and retained wb tool counts by period, project, bucket, and top threads.
 */
import type Database from "better-sqlite3";
import type { WorkbenchStatsTools } from "workbench-shared/workbench/stats/workbench-stats-tools-contract";

/** Codex splits wb tools across a Code-mode-eligible `wb` server and a direct-only `wbex` server. */
export const WORKBENCH_TOOL_SERVERS: readonly string[] = ["wb", "wbex"];

const MAX_BUCKET_THREADS = 3;
const DAY_MS = 86_400_000;

interface Period {
  bucketMs: number;
  count: number;
  endedAt: number;
  startedAt: number;
}

export default class WorkbenchToolStatsRepository {
  constructor(private readonly database: Database.Database) {}

  /** Tool tokens are daemon-owned, so rows carry calls only; the stats controller adds the catalogue. */
  read(projectIds: readonly string[] | null, period: Period, now: number): WorkbenchStatsTools {
    const parameters = {
      bucket: period.bucketMs,
      end: Math.min(period.endedAt, now + 1),
      projects: projectIds === null ? null : JSON.stringify(projectIds),
      servers: JSON.stringify(WORKBENCH_TOOL_SERVERS),
      start: period.startedAt,
    };
    // Codex's wb and wbex servers are one catalogue, so tools group by name alone.
    const scope = `
      FROM thread_operation_callable_tool_sources c
      JOIN thread_operation_tool_sources t ON t.item_id = c.item_id
      JOIN thread_items i ON i.id = c.item_id
      JOIN workbench_threads th ON th.id = i.thread_id
      WHERE c.server_name IN (SELECT value FROM json_each(@servers))
        AND i.created_at >= @start AND i.created_at < @end
        AND (@projects IS NULL OR th.project_id IN (SELECT value FROM json_each(@projects)))
    `;
    // One row per tool, bucket and thread: totals, distinct threads and each bucket's top callers all fold from it.
    const calls = period.count ? this.database.prepare(`
      SELECT tool, bucket, thread_id, SUM(calls) calls, SUM(failed) failed
      FROM (
        SELECT c.tool_name tool, CAST((i.created_at - @start) / @bucket AS INTEGER) bucket, i.thread_id thread_id,
          COUNT(*) calls, SUM(t.state = 'failed') failed
        ${scope}
        GROUP BY tool, bucket, thread_id
        UNION ALL
        SELECT aggregate.tool_name, CAST((aggregate.day * ${DAY_MS} - @start) / @bucket AS INTEGER),
          aggregate.thread_id, aggregate.call_count, aggregate.failure_count
        FROM thread_tool_daily_aggregates aggregate
        WHERE aggregate.day * ${DAY_MS} >= @start AND aggregate.day * ${DAY_MS} < @end
          AND (@projects IS NULL OR aggregate.project_id IN (SELECT value FROM json_each(@projects)))
      )
      GROUP BY tool, bucket, thread_id
    `).all(parameters) as Array<{ bucket: number; calls: number; failed: number; thread_id: string; tool: string }> : [];

    const rows = new Map<string, {
      buckets: number[]; bucketCallers: Array<Array<{ calls: number; threadId: string }>>; calls: number; failed: number; threads: Set<string>;
    }>();
    for (const row of calls) {
      const target = rows.get(row.tool) ?? {
        buckets: new Array<number>(period.count).fill(0),
        bucketCallers: Array.from({ length: period.count }, () => []),
        calls: 0, failed: 0, threads: new Set<string>(),
      };
      rows.set(row.tool, target);
      target.calls += row.calls;
      target.failed += row.failed;
      target.threads.add(row.thread_id);
      const index = Math.min(period.count - 1, Math.max(0, row.bucket));
      target.buckets[index] = (target.buckets[index] ?? 0) + row.calls;
      target.bucketCallers[index]!.push({ calls: row.calls, threadId: row.thread_id });
    }

    const threadIndex = new Map<string, number>();
    const tools = [...rows.entries()].map(([tool, row]) => ({
      buckets: row.buckets,
      bucketThreads: row.bucketCallers.map((callers) => callers
        .sort((left, right) => right.calls - left.calls || left.threadId.localeCompare(right.threadId))
        .slice(0, MAX_BUCKET_THREADS)
        .map(({ calls: threadCalls, threadId }) => {
          if (!threadIndex.has(threadId)) threadIndex.set(threadId, threadIndex.size);
          return { calls: threadCalls, thread: threadIndex.get(threadId)! };
        })),
      calls: row.calls, docsTokens: 0, failed: row.failed, specTokens: null, threads: row.threads.size, tool,
    })).sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool));

    // The thread a tooltip names opens on the provider it started with.
    const named = [...threadIndex.keys()];
    const details = new Map(named.length ? (this.database.prepare(`
      SELECT th.id thread_id, th.project_id, th.title,
        (SELECT tr.harness_id FROM thread_turns tr WHERE tr.thread_id = th.id ORDER BY tr.turn_index LIMIT 1) harness
      FROM workbench_threads th WHERE th.id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(named)) as Array<{ harness: string | null; project_id: string; thread_id: string; title: string | null }>)
      .map((row) => [row.thread_id, row]) : []);
    return {
      bucketStarts: Array.from({ length: period.count }, (_, index) => period.startedAt + index * period.bucketMs),
      catalogue: null,
      threadCount: new Set(calls.map(({ thread_id }) => thread_id)).size,
      threads: named.map((threadId) => {
        const detail = details.get(threadId);
        return { harness: detail?.harness ?? null, projectId: detail?.project_id ?? "unknown", threadId, title: (detail?.title ?? "").slice(0, 500) };
      }),
      workbench: tools,
    };
  }
}
