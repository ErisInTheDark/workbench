/*
 * Exports:
 * - WorkbenchStatsUsageImportCandidate: queued usage import.
 * - WorkbenchGitClaimImportCandidate: queued claim import.
 * - WorkbenchGitClaimImportDiscovery: discovered claim source.
 * - WorkbenchGitClaimImportSettlement: settled claim import.
 * - WorkbenchStatsUsageImportSettlement: settled usage import.
 * - default WorkbenchStatsImportRepository: own versioned SQLite usage/claim queues, settlements, facts, and progress.
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStatsImportProgress } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { WORKBENCH_STATS_USAGE_DATA_VERSION, WORKBENCH_STATS_USAGE_IMPORT_VERSION } from "workbench-shared/workbench/stats/workbench-stats-usage";

export interface WorkbenchStatsUsageImportCandidate {
  harness: WorkbenchHarness;
  kind: "usage";
  projectId: string;
  threadId: string;
}

export interface WorkbenchGitClaimImportDiscovery {
  checkpointCommit: string;
  checkpointRef: string;
  harness: WorkbenchHarness;
  observedAt: number;
  projectId: string;
  repositoryRoot: string;
  rootId: string;
  threadId: string;
  workspaceRoot: string;
}

export interface WorkbenchGitClaimImportCandidate extends WorkbenchGitClaimImportDiscovery {
  kind: "claims";
}

export interface WorkbenchStatsUsageImportSettlement {
  error?: string;
  state: "completed" | "unavailable" | "failed";
}

export interface WorkbenchGitClaimImportSettlement {
  error?: string;
  paths?: string[];
  state: "completed" | "failed";
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const boundedError = (error: string | undefined) => error?.replaceAll(/[\r\n]+/gu, " ").slice(0, 500) ?? null;

export default class WorkbenchStatsImportRepository {
  constructor(private readonly database: Database.Database) {}

  beginUsage(runId: string, harnesses: readonly WorkbenchHarness[], now: number) {
    if (!harnesses.length) return;
    const placeholders = harnesses.map(() => "?").join(", ");
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE thread_turn_usage
        SET cumulative_input_tokens = NULL,
          cumulative_cached_input_tokens = NULL,
          cumulative_cache_write_input_tokens = NULL,
          cumulative_output_tokens = NULL,
          cumulative_reasoning_output_tokens = NULL,
          cumulative_total_tokens = NULL,
          usage_data_version = NULL,
          usage_observed_at = NULL
        WHERE usage_data_version IS NOT NULL AND usage_data_version != ?
      `).run(WORKBENCH_STATS_USAGE_DATA_VERSION);
      this.database.prepare(`
        INSERT OR IGNORE INTO thread_usage_imports (
          project_id, harness_id, provider_thread_id, state, run_id, attempt_count,
          discovered_at, source_activity_at, started_at, settled_at, updated_at, error_text,
          completed_data_version
        )
        SELECT i.project_id, i.harness_id, i.provider_thread_id, 'pending', NULL, 0,
          ?, t.activity_at, NULL, NULL, ?, NULL, NULL
        FROM workbench_thread_state_provider_identities i
        JOIN workbench_thread_state_threads t ON t.id = i.thread_id
        WHERE i.harness_id IN (${placeholders})
      `).run(now, now, ...harnesses);
      this.database.prepare(`
        UPDATE thread_usage_imports
        SET state = 'pending', run_id = NULL, started_at = NULL, settled_at = NULL,
          updated_at = ?, error_text = NULL, completed_data_version = NULL
        WHERE harness_id IN (${placeholders})
          AND (completed_data_version IS NULL OR completed_data_version != ?)
      `).run(now, ...harnesses, WORKBENCH_STATS_USAGE_IMPORT_VERSION);
      this.database.prepare(`
        UPDATE thread_usage_imports
        SET state = 'pending', run_id = NULL, started_at = NULL, settled_at = NULL,
          updated_at = ?, error_text = NULL
        WHERE harness_id IN (${placeholders}) AND state IN ('processing', 'failed')
          AND (run_id IS NULL OR run_id != ?)
      `).run(now, ...harnesses, runId);
      this.database.prepare(`
        INSERT INTO workbench_harnesses(id)
        SELECT DISTINCT harness_id FROM git_claim_sessions WHERE harness_id IS NOT NULL
        ON CONFLICT(id) DO NOTHING
      `).run();
      this.database.prepare(`
        INSERT OR IGNORE INTO git_claim_thread_file_days (
          project_id, root_id, harness_id, thread_id, claimed_path, claimed_day
        )
        SELECT project_id, root_id, harness_id, thread_id, claimed_path,
          claimed_at - (claimed_at % ${DAY_MS})
        FROM git_claim_sessions
      `).run();
    })();
  }

  addClaimDiscoveries(runId: string, discoveries: readonly WorkbenchGitClaimImportDiscovery[], now: number) {
    const insert = this.database.prepare(`
      INSERT INTO git_claim_imports (
        project_id, root_id, repository_root, workspace_root, checkpoint_ref, checkpoint_commit,
        harness_id, thread_id, observed_at, state, run_id, attempt_count, updated_at, error_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, ?, NULL)
      ON CONFLICT(project_id, root_id, checkpoint_ref) DO UPDATE SET
        repository_root = excluded.repository_root,
        workspace_root = excluded.workspace_root,
        checkpoint_commit = excluded.checkpoint_commit,
        harness_id = excluded.harness_id,
        thread_id = excluded.thread_id,
        observed_at = excluded.observed_at,
        state = CASE WHEN git_claim_imports.checkpoint_commit = excluded.checkpoint_commit
          AND git_claim_imports.state = 'completed' THEN 'completed' ELSE 'pending' END,
        run_id = NULL,
        updated_at = excluded.updated_at,
        error_text = NULL
    `);
    this.database.transaction(() => {
      for (const discovery of discoveries) {
        this.database.prepare("INSERT INTO workbench_harnesses(id) VALUES (?) ON CONFLICT(id) DO NOTHING").run(discovery.harness);
        insert.run(
          discovery.projectId,
          discovery.rootId,
          discovery.repositoryRoot,
          discovery.workspaceRoot,
          discovery.checkpointRef,
          discovery.checkpointCommit,
          discovery.harness,
          discovery.threadId,
          discovery.observedAt,
          now,
        );
      }
      this.database.prepare(`
        UPDATE git_claim_imports SET state = 'pending', run_id = NULL, updated_at = ?, error_text = NULL
        WHERE state IN ('processing', 'failed') AND (run_id IS NULL OR run_id != ?)
      `).run(now, runId);
    })();
  }

  claimUsage(runId: string, harnesses: readonly WorkbenchHarness[], now: number): WorkbenchStatsUsageImportCandidate | null {
    if (!harnesses.length) return null;
    const placeholders = harnesses.map(() => "?").join(", ");
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT project_id, harness_id, provider_thread_id FROM thread_usage_imports
        WHERE state = 'pending' AND harness_id IN (${placeholders})
        ORDER BY source_activity_at DESC, project_id, harness_id, provider_thread_id LIMIT 1
      `).get(...harnesses) as { harness_id: WorkbenchHarness; project_id: string; provider_thread_id: string } | undefined;
      if (!row) return null;
      this.database.prepare(`
        UPDATE thread_usage_imports SET state = 'processing', run_id = ?,
          attempt_count = attempt_count + 1, started_at = ?, settled_at = NULL,
          updated_at = ?, error_text = NULL
        WHERE project_id = ? AND harness_id = ? AND provider_thread_id = ? AND state = 'pending'
      `).run(runId, now, now, row.project_id, row.harness_id, row.provider_thread_id);
      return {
        harness: row.harness_id,
        kind: "usage" as const,
        projectId: row.project_id,
        threadId: row.provider_thread_id,
      };
    })();
  }

  claimClaims(runId: string, now: number): WorkbenchGitClaimImportCandidate | null {
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM git_claim_imports WHERE state = 'pending'
        ORDER BY observed_at DESC, project_id, root_id, checkpoint_ref LIMIT 1
      `).get() as {
        checkpoint_commit: string; checkpoint_ref: string; harness_id: WorkbenchHarness;
        observed_at: number; project_id: string; repository_root: string; root_id: string; thread_id: string; workspace_root: string;
      } | undefined;
      if (!row) return null;
      this.database.prepare(`
        UPDATE git_claim_imports SET state = 'processing', run_id = ?,
          attempt_count = attempt_count + 1, updated_at = ?, error_text = NULL
        WHERE project_id = ? AND root_id = ? AND checkpoint_ref = ? AND state = 'pending'
      `).run(runId, now, row.project_id, row.root_id, row.checkpoint_ref);
      return {
        checkpointCommit: row.checkpoint_commit,
        checkpointRef: row.checkpoint_ref,
        harness: row.harness_id,
        kind: "claims" as const,
        observedAt: row.observed_at,
        projectId: row.project_id,
        repositoryRoot: row.repository_root,
        rootId: row.root_id,
        threadId: row.thread_id,
        workspaceRoot: row.workspace_root,
      };
    })();
  }

  settleUsage(runId: string, candidate: WorkbenchStatsUsageImportCandidate, settlement: WorkbenchStatsUsageImportSettlement, now: number) {
    this.database.prepare(`
      UPDATE thread_usage_imports SET state = ?, run_id = NULL, settled_at = ?,
        updated_at = ?, error_text = ?,
        completed_data_version = CASE WHEN ? IN ('completed', 'unavailable') THEN ? ELSE NULL END
      WHERE project_id = ? AND harness_id = ? AND provider_thread_id = ?
        AND state = 'processing' AND run_id = ?
    `).run(
      settlement.state, now, now, boundedError(settlement.error),
      settlement.state, WORKBENCH_STATS_USAGE_IMPORT_VERSION,
      candidate.projectId, candidate.harness, candidate.threadId, runId,
    );
  }

  settleClaims(runId: string, candidate: WorkbenchGitClaimImportCandidate, settlement: WorkbenchGitClaimImportSettlement, now: number) {
    this.database.transaction(() => {
      if (settlement.state === "completed") {
        const insert = this.database.prepare(`
          INSERT OR IGNORE INTO git_claim_thread_file_days (
            project_id, root_id, harness_id, thread_id, claimed_path, claimed_day
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        const claimedDay = candidate.observedAt - candidate.observedAt % DAY_MS;
        for (const path of new Set(settlement.paths ?? [])) {
          insert.run(candidate.projectId, candidate.rootId, candidate.harness, candidate.threadId, path, claimedDay);
        }
      }
      this.database.prepare(`
        UPDATE git_claim_imports SET state = ?, run_id = NULL, updated_at = ?, error_text = ?
        WHERE project_id = ? AND root_id = ? AND checkpoint_ref = ?
          AND state = 'processing' AND run_id = ?
      `).run(
        settlement.state, now, boundedError(settlement.error),
        candidate.projectId, candidate.rootId, candidate.checkpointRef, runId,
      );
    })();
  }

  progress(state: WorkbenchStatsImportProgress["state"], revision: number, unsupportedClaimCheckpoints: number): WorkbenchStatsImportProgress {
    const counts = (table: string) => this.database.prepare(`
      SELECT COUNT(*) total,
        SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) completed,
        SUM(CASE WHEN state = 'unavailable' THEN 1 ELSE 0 END) unavailable,
        SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) failed
      FROM ${table}
    `).get() as { completed: number | null; failed: number | null; total: number; unavailable: number | null };
    const source = (value: ReturnType<typeof counts>) => {
      const completed = value.completed ?? 0;
      const failed = value.failed ?? 0;
      const unavailable = value.unavailable ?? 0;
      return { completed, failed, processed: completed + failed + unavailable, total: value.total, unavailable };
    };
    const usage = source(counts("thread_usage_imports"));
    const claims = source(counts("git_claim_imports"));
    const total = usage.total + claims.total;
    const processed = usage.processed + claims.processed;
    const usageFailures = this.database.prepare(`
      SELECT harness_id harness, provider_thread_id subject, error_text message
      FROM thread_usage_imports WHERE state = 'failed' ORDER BY updated_at DESC LIMIT 10
    `).all() as Array<{ harness: string; message: string | null; subject: string }>;
    const claimFailures = this.database.prepare(`
      SELECT harness_id harness, checkpoint_ref subject, error_text message
      FROM git_claim_imports WHERE state = 'failed' ORDER BY updated_at DESC LIMIT 10
    `).all() as Array<{ harness: string; message: string | null; subject: string }>;
    return {
      claims,
      percent: total ? processed / total * 100 : 100,
      recentFailures: [
        ...usageFailures.map((failure) => ({ ...failure, message: failure.message ?? "Usage hydration failed.", source: "usage" as const })),
        ...claimFailures.map((failure) => ({ ...failure, message: failure.message ?? "Claim hydration failed.", source: "claims" as const })),
      ].slice(0, 20),
      revision,
      state,
      unsupportedClaimCheckpoints,
      usage,
      version: 2,
    };
  }
}
