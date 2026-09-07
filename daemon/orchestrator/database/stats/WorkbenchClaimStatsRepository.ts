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
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository.ts";

const CLAIM_IDENTITIES = `
  WITH native AS (
    SELECT t.harness_id, t.native_thread_id, w.project_id, MIN(t.thread_id) thread_id
    FROM (
      SELECT thread_id, harness_id, native_thread_id FROM thread_turns
      UNION SELECT thread_id, harness_id, native_thread_id FROM workbench_pending_import_threads
    ) t JOIN workbench_threads w ON w.id = t.thread_id
    GROUP BY t.harness_id, t.native_thread_id, w.project_id
    HAVING COUNT(DISTINCT t.thread_id) = 1
  ), resolved AS (
    SELECT c.*,
      COALESCE(w.id, a.thread_id, n.thread_id) managed_id
    FROM git_claim_thread_file_days c
    LEFT JOIN workbench_thread_legacy_aliases a
      ON a.alias = c.thread_id AND EXISTS (SELECT 1 FROM workbench_threads owner WHERE owner.id = a.thread_id AND owner.project_id = c.project_id)
    LEFT JOIN workbench_threads w ON w.id = c.thread_id AND w.project_id = c.project_id
    LEFT JOIN native n
      ON n.native_thread_id = c.thread_id AND n.harness_id = c.harness_id AND n.project_id = c.project_id
    WHERE c.claimed_day BETWEEN @startedAt AND @endedAt
      AND (@projectId IS NULL OR c.project_id = @projectId)
  ), claims AS (
    SELECT *, COALESCE(managed_id, thread_id) identity_id,
      COALESCE(managed_id, harness_id || char(0) || thread_id) claimant_key FROM resolved
  )
`;

export default class WorkbenchClaimStatsRepository {
  private readonly identities: WorkbenchThreadIdentityRepository;

  constructor(private readonly database: Database.Database) {
    this.identities = new WorkbenchThreadIdentityRepository(database);
  }

  hotspots(projectId: string | null, startedAt: number, now: number) {
    const rows = this.database.prepare(`${CLAIM_IDENTITIES}
      SELECT project_id, root_id, claimed_path, COUNT(DISTINCT claimant_key) thread_count
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
        SELECT project_id, MIN(harness_id) harness_id, identity_id, MAX(managed_id) managed_id, MAX(claimed_day) last_day
        FROM claims WHERE root_id = @rootId AND claimed_path = @path
        GROUP BY project_id, claimant_key
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
        rows: rows.map((row) => {
          let identity = row.managed_id
            ? this.identities.resolve({ threadId: row.managed_id, projectId: request.projectId })
            : null;
          if (row.managed_id && !identity) {
            const native = this.database.prepare(`
              SELECT harness_id harness, native_location nativeLocation, native_thread_id nativeThreadId
              FROM thread_turns WHERE thread_id = ?
              UNION SELECT harness_id, native_location, native_thread_id
              FROM workbench_pending_import_threads WHERE thread_id = ?
              LIMIT 1
            `).get(row.managed_id, row.managed_id) as { harness: string; nativeLocation: string; nativeThreadId: string } | undefined;
            if (native) identity = this.identities.resolveNative(native);
          }
          return {
            threadId: identity?.threadId ?? row.identity_id, title: row.title, harness: row.harness_id,
            identity: identity ? "managed" as const : "provider" as const,
          };
        }),
      };
    }
    const count = this.database.prepare(`${CLAIM_IDENTITIES}
      SELECT COUNT(*) count FROM (SELECT root_id, claimed_path FROM claims GROUP BY root_id, claimed_path)
    `).get(params) as { count: number };
    const rows = this.database.prepare(`${CLAIM_IDENTITIES}
      SELECT root_id, claimed_path, COUNT(DISTINCT claimant_key) thread_count
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
