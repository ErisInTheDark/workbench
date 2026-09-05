/*
 * Keywords: sqlite, claims, distinct threads, identity, titles, paging.
 * Exports:
 * - default WorkbenchClaimStatsRepository: read shared UI hotspots and cwd-scoped CLI claim analysis.
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import { statsRangeShape } from "workbench-shared/workbench/stats/workbench-stats-contract";
import {
  WORKBENCH_CLAIM_STATS_PAGE_SIZE,
  type WorkbenchClaimStatsRequest,
  type WorkbenchClaimStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-claims-contract";

const CLAIM_IDENTITIES = `
  WITH native AS (
    SELECT t.harness_id, t.native_thread_id, w.project_id, MIN(t.thread_id) thread_id
    FROM thread_turns t JOIN workbench_threads w ON w.id = t.thread_id
    GROUP BY t.harness_id, t.native_thread_id, w.project_id
    HAVING COUNT(DISTINCT t.thread_id) = 1
  ), resolved AS (
    SELECT c.*,
      COALESCE(s.id, p.thread_id, w.id, n.thread_id) managed_id
    FROM git_claim_thread_file_days c
    LEFT JOIN workbench_thread_state_threads s ON s.id = c.thread_id AND s.project_id = c.project_id
    LEFT JOIN workbench_thread_state_provider_identities p
      ON p.provider_thread_id = c.thread_id AND p.harness_id = c.harness_id AND p.project_id = c.project_id
    LEFT JOIN workbench_threads w ON w.id = c.thread_id AND w.project_id = c.project_id
    LEFT JOIN native n
      ON n.native_thread_id = c.thread_id AND n.harness_id = c.harness_id AND n.project_id = c.project_id
    WHERE c.claimed_day BETWEEN @startedAt AND @endedAt
      AND (@projectId IS NULL OR c.project_id = @projectId)
  ), claims AS (
    SELECT *, COALESCE(managed_id, thread_id) identity_id FROM resolved
  )
`;

export default class WorkbenchClaimStatsRepository {
  constructor(private readonly database: Database.Database) {}

  hotspots(projectId: string | null, startedAt: number, now: number) {
    const rows = this.database.prepare(`${CLAIM_IDENTITIES}
      SELECT project_id, root_id, claimed_path, COUNT(DISTINCT harness_id || char(0) || identity_id) thread_count
      FROM claims GROUP BY project_id, root_id, claimed_path
      ORDER BY thread_count DESC, claimed_path, project_id, root_id LIMIT 20
    `).all({ projectId, startedAt, endedAt: Math.floor(now / 86_400_000) * 86_400_000 }) as Array<{
      project_id: string; root_id: string; claimed_path: string; thread_count: number;
    }>;
    return rows.map((row) => ({
      projectId: row.project_id, rootId: row.root_id, path: row.claimed_path, threadCount: row.thread_count,
    }));
  }

  read(request: WorkbenchClaimStatsRequest, now = Date.now()): WorkbenchClaimStatsResponse {
    const params = {
      projectId: request.projectId,
      startedAt: request.range === "all" ? 0 : statsRangeShape(request.range, now).startedAt,
      endedAt: Math.floor(now / 86_400_000) * 86_400_000,
    };
    const pageSize = WORKBENCH_CLAIM_STATS_PAGE_SIZE;
    const page = request.page;
    if (request.file) {
      const scoped = { ...params, rootId: request.file.rootId, path: request.file.path };
      const query = `${CLAIM_IDENTITIES}, selected AS (
        SELECT project_id, harness_id, identity_id, MAX(managed_id) managed_id, MAX(claimed_day) last_day
        FROM claims WHERE root_id = @rootId AND claimed_path = @path
        GROUP BY project_id, harness_id, identity_id
      )`;
      const count = this.database.prepare(`${query} SELECT COUNT(*) count FROM selected`).get(scoped) as { count: number };
      const rows = this.database.prepare(`${query}
        SELECT c.identity_id, c.harness_id, c.managed_id,
          COALESCE(NULLIF(s.title, ''), NULLIF(w.title, '')) title
        FROM selected c
        LEFT JOIN workbench_thread_state_threads s ON s.id = c.managed_id AND s.project_id = c.project_id
        LEFT JOIN workbench_threads w ON w.id = c.managed_id AND w.project_id = c.project_id
        ORDER BY c.last_day DESC, c.identity_id, c.harness_id
        LIMIT @limit OFFSET @offset
      `).all({ ...scoped, limit: pageSize, offset: (page - 1) * pageSize }) as Array<{
        identity_id: string; harness_id: WorkbenchHarness; managed_id: string | null; title: string | null;
      }>;
      return {
        kind: "threads", page, pages: Math.max(1, Math.ceil(count.count / pageSize)),
        rows: rows.map((row) => ({
          threadId: row.identity_id, title: row.title, harness: row.harness_id,
          identity: row.managed_id ? "managed" : "provider",
        })),
      };
    }
    const count = this.database.prepare(`${CLAIM_IDENTITIES}
      SELECT COUNT(*) count FROM (SELECT root_id, claimed_path FROM claims GROUP BY root_id, claimed_path)
    `).get(params) as { count: number };
    const rows = this.database.prepare(`${CLAIM_IDENTITIES}
      SELECT root_id, claimed_path, COUNT(DISTINCT harness_id || char(0) || identity_id) thread_count
      FROM claims GROUP BY root_id, claimed_path
      ORDER BY thread_count DESC, root_id, claimed_path
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: pageSize, offset: (page - 1) * pageSize }) as Array<{
      root_id: string; claimed_path: string; thread_count: number;
    }>;
    return {
      kind: "files", page, pages: Math.max(1, Math.ceil(count.count / pageSize)),
      rows: rows.map((row) => ({ rootId: row.root_id, path: row.claimed_path, threadCount: row.thread_count })),
    };
  }
}
