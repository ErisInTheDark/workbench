/*
 * No production exports. Tests protect versioned resumable usage imports, fenced claim queues, and deduplicated claim facts. Keywords: stats, import, version, sqlite, test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchStatsImportRepository from "./WorkbenchStatsImportRepository.ts";

test("usage and claim imports resume safely and isolate failed work", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  database.exec(`
    INSERT INTO workbench_thread_state_threads
      (id, project_id, thread_kind, visibility, title, archived, pinned, snoozed, provider_observed, created_at, updated_at, activity_at, order_at)
    VALUES ('thread', 'project', 'topLevel', 'visible', 'thread', 0, 0, 0, 1, 1, 1, 20, NULL);
    INSERT INTO workbench_thread_state_provider_identities (thread_id, project_id, harness_id, provider_thread_id)
    VALUES ('thread', 'project', 'codex', 'provider-thread');
  `);
  try {
    const repository = new WorkbenchStatsImportRepository(database);
    repository.beginUsage("run-a", ["codex"], 100);
    const first = repository.claimUsage("run-a", ["codex"], 101);
    assert.equal(first?.threadId, "provider-thread");
    repository.beginUsage("run-b", ["codex"], 102);
    repository.settleUsage("run-a", first!, { state: "completed" }, 103);
    const reclaimed = repository.claimUsage("run-b", ["codex"], 104);
    assert.equal(reclaimed?.threadId, "provider-thread");
    repository.settleUsage("run-b", reclaimed!, { error: "bad\njournal", state: "failed" }, 105);

    repository.addClaimDiscoveries("run-b", [{
      checkpointCommit: "a".repeat(40),
      checkpointRef: "refs/worktree/agents/codex/thread/checkpoints/one",
      harness: "codex",
      observedAt: Date.UTC(2026, 8, 4),
      projectId: "project",
      repositoryRoot: "C:/project",
      rootId: "root",
      threadId: "thread",
      workspaceRoot: "C:/project",
    }], 106);
    const claim = repository.claimClaims("run-b", 107);
    assert.ok(claim);
    repository.settleClaims("run-b", claim, { paths: ["src/file.ts", "src/file.ts"], state: "completed" }, 108);

    const progress = repository.progress("running", 3, 0);
    assert.equal(progress.usage.failed, 1);
    assert.equal(progress.claims.completed, 1);
    assert.equal(progress.recentFailures[0]?.message, "bad journal");
    assert.equal((database.prepare("SELECT COUNT(*) count FROM git_claim_thread_file_days").get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});

test("usage schema v10 preserves pricing context while discarding v1 token facts", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  database.exec(`
    INSERT INTO workbench_harnesses (id) VALUES ('codex');
    INSERT INTO workbench_threads
      (id, project_id, project_root, title, transcript_content_version,
       created_at, updated_at, activity_at, next_turn_index)
    VALUES ('thread', 'project', 'C:/project', 'thread', 1, 1, 1, 1, 1);
    INSERT INTO thread_turns
      (id, thread_id, turn_index, harness_id, native_location, native_thread_id, native_turn_id,
       state, created_at, started_at, ended_at, duration_ms)
    VALUES ('turn', 'thread', 0, 'codex', 'C:/project', 'provider-thread', 'turn',
      'completed', 1, 1, 2, 1);
  `);
  database.pragma("foreign_keys = OFF");
  database.exec(`
    DROP TABLE thread_turn_usage;
    CREATE TABLE thread_turn_usage (
      turn_id TEXT PRIMARY KEY REFERENCES thread_turns(id) ON DELETE CASCADE,
      model TEXT,
      service_tier TEXT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      cache_write_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      total_tokens INTEGER,
      context_observed_at INTEGER,
      usage_observed_at INTEGER
    );
    INSERT INTO thread_turn_usage VALUES
      ('turn', 'gpt-5.4', 'standard', 100, 80, 0, 20, 5, 120, 1, 2);
    DROP TABLE thread_usage_imports;
    CREATE TABLE thread_usage_imports (
      project_id TEXT NOT NULL,
      harness_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      state TEXT NOT NULL,
      run_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      discovered_at INTEGER NOT NULL,
      source_activity_at INTEGER NOT NULL,
      started_at INTEGER,
      settled_at INTEGER,
      updated_at INTEGER NOT NULL,
      error_text TEXT
    );
    INSERT INTO thread_usage_imports VALUES
      ('project', 'codex', 'provider-thread', 'completed', NULL, 1, 1, 2, 2, 2, 2, NULL);
    PRAGMA user_version = 9;
  `);
  database.pragma("foreign_keys = ON");
  try {
    installWorkbenchDatabaseSchema(database);
    const usageColumns = (database.prepare("PRAGMA table_info(thread_turn_usage)").all() as Array<{ name: string }>)
      .map(({ name }) => name);
    assert.equal(usageColumns.includes("input_tokens"), false);
    assert.equal(usageColumns.includes("cumulative_input_tokens"), true);
    assert.deepEqual(database.prepare(`
      SELECT model, service_tier, context_observed_at, usage_observed_at, usage_data_version
      FROM thread_turn_usage WHERE turn_id = 'turn'
    `).get(), {
      context_observed_at: 1,
      model: "gpt-5.4",
      service_tier: "standard",
      usage_data_version: null,
      usage_observed_at: null,
    });
    assert.equal((database.prepare(`
      SELECT completed_data_version FROM thread_usage_imports
    `).get() as { completed_data_version: number | null }).completed_data_version, null);
  } finally {
    database.close();
  }
});

test("usage import version changes discard stale token facts and requeue completed work", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  database.exec(`
    INSERT INTO workbench_harnesses (id) VALUES ('codex');
    INSERT INTO workbench_threads
      (id, project_id, project_root, title, transcript_content_version,
       created_at, updated_at, activity_at, next_turn_index)
    VALUES ('thread', 'project', 'C:/project', 'thread', 1, 1, 1, 1, 1);
    INSERT INTO thread_turns
      (id, thread_id, turn_index, harness_id, native_location, native_thread_id, native_turn_id,
       state, created_at, started_at, ended_at, duration_ms)
    VALUES ('turn', 'thread', 0, 'codex', 'C:/project', 'provider-thread', 'turn',
      'completed', 1, 1, 2, 1);
    INSERT INTO thread_turn_usage
      (turn_id, model, service_tier, cumulative_input_tokens, cumulative_cached_input_tokens,
       cumulative_cache_write_input_tokens, cumulative_output_tokens,
       cumulative_reasoning_output_tokens, cumulative_total_tokens, usage_data_version,
       context_observed_at, usage_observed_at)
    VALUES ('turn', 'gpt-5.4', 'standard', 100, 80, 0, 20, 5, 120, 1, 1, 2);
    INSERT INTO workbench_thread_state_threads
      (id, project_id, thread_kind, visibility, title, archived, pinned, snoozed, provider_observed,
       created_at, updated_at, activity_at, order_at)
    VALUES ('thread', 'project', 'topLevel', 'visible', 'thread', 0, 0, 0, 1, 1, 1, 2, NULL);
    INSERT INTO workbench_thread_state_provider_identities
      (thread_id, project_id, harness_id, provider_thread_id)
    VALUES ('thread', 'project', 'codex', 'provider-thread');
    INSERT INTO thread_usage_imports
      (project_id, harness_id, provider_thread_id, state, run_id, attempt_count, discovered_at,
       source_activity_at, started_at, settled_at, updated_at, error_text, completed_data_version)
    VALUES ('project', 'codex', 'provider-thread', 'completed', NULL, 1, 1, 2, 2, 2, 2, NULL, 1);
  `);
  try {
    const repository = new WorkbenchStatsImportRepository(database);
    repository.beginUsage("run", ["codex"], 10);
    assert.equal((database.prepare(`
      SELECT COUNT(*) count FROM thread_turn_usage WHERE usage_data_version IS NOT NULL
    `).get() as { count: number }).count, 0);
    assert.deepEqual(database.prepare(`
      SELECT model, service_tier FROM thread_turn_usage WHERE turn_id = 'turn'
    `).get(), { model: "gpt-5.4", service_tier: "standard" });
    const candidate = repository.claimUsage("run", ["codex"], 11);
    assert.equal(candidate?.threadId, "provider-thread");
    repository.settleUsage("run", candidate!, { state: "completed" }, 12);
    assert.equal((database.prepare(`
      SELECT completed_data_version FROM thread_usage_imports
      WHERE provider_thread_id = 'provider-thread'
    `).get() as { completed_data_version: number }).completed_data_version, 2);

    database.prepare(`
      UPDATE thread_usage_imports
      SET state = 'pending', completed_data_version = NULL
      WHERE provider_thread_id = 'provider-thread'
    `).run();
    const unavailable = repository.claimUsage("unavailable-run", ["codex"], 13);
    repository.settleUsage("unavailable-run", unavailable!, { state: "unavailable" }, 14);
    assert.deepEqual(database.prepare(`
      SELECT state, completed_data_version FROM thread_usage_imports
      WHERE provider_thread_id = 'provider-thread'
    `).get(), { completed_data_version: 2, state: "unavailable" });

    database.exec(`
      UPDATE thread_turn_usage SET
        cumulative_input_tokens = 100,
        cumulative_cached_input_tokens = 80,
        cumulative_cache_write_input_tokens = 0,
        cumulative_output_tokens = 20,
        cumulative_reasoning_output_tokens = 5,
        cumulative_total_tokens = 120,
        usage_data_version = 2,
        usage_observed_at = 14
      WHERE turn_id = 'turn';
    `);
    repository.beginUsage("next-run", ["codex"], 20);
    assert.equal(repository.claimUsage("next-run", ["codex"], 21), null);
    assert.deepEqual(database.prepare(`
      SELECT cumulative_total_tokens, usage_data_version
      FROM thread_turn_usage WHERE turn_id = 'turn'
    `).get(), { cumulative_total_tokens: 120, usage_data_version: 2 });
  } finally {
    database.close();
  }
});
