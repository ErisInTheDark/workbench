/*
 * No production exports. Tests protect resumable usage imports, fenced claim queues and deduplicated claim facts.
 */
import assert from "node:assert/strict";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import test from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchStatsImportRepository from "./WorkbenchStatsImportRepository.ts";
import { WORKBENCH_STATS_USAGE_IMPORT_VERSION } from "workbench-shared/workbench/stats/workbench-stats-usage";

test("claim discovery admits future providers independently of thread admission and remains repeat-safe", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  try {
    const repository = new WorkbenchStatsImportRepository(database);
    const discovery = {
      checkpointCommit: "a".repeat(40), checkpointRef: "refs/worktree/agents/future-provider/thread/checkpoints/one",
      harness: "future-provider", observedAt: Date.UTC(2026, 8, 4), projectId: testProjectIds.project,
      repositoryRoot: "C:/project", rootId: "root", threadId: "thread", workspaceRoot: "C:/project",
    };
    repository.addClaimDiscoveries("run", [discovery, discovery], 1);
    assert.ok(database.prepare("SELECT id FROM workbench_projects WHERE id = ?").get(discovery.projectId));
    const claim = repository.claimClaims("run", 2);
    assert.ok(claim);
    database.prepare("INSERT INTO workbench_project_aliases(alias, project_id) VALUES ('old-claims', ?)").run(discovery.projectId);
    repository.settleClaims("run", { ...claim, projectId: "old-claims" }, { paths: ["src/file.ts"], state: "completed" }, 3);
    repository.addClaimDiscoveries("run", [discovery], 4);
    assert.equal(repository.claimClaims("run", 5), null);
    assert.deepEqual(database.prepare("SELECT harness_id, thread_id FROM git_claim_thread_file_days").all(), [
      { harness_id: "future-provider", thread_id: "thread" },
    ]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("usage and claim imports resume safely and isolate failed work", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  database.exec(`
    INSERT INTO workbench_harnesses(id) VALUES ('codex');
    INSERT INTO workbench_projects(id) VALUES ('${testProjectIds.project}');
    INSERT INTO workbench_threads
      (id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at, next_turn_index)
    VALUES ('thread', '${testProjectIds.project}', 'C:/project', 'thread', 0, 1, 1, 20, 0);
    INSERT INTO workbench_pending_import_threads (thread_id, harness_id, native_location, native_thread_id, discovered_at, last_seen_at)
    VALUES ('thread', 'codex', 'C:/project', 'provider-thread', 1, 20);
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
      projectId: testProjectIds.project,
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

test("removed project roots do not retry unfinished claim imports or lose completed facts", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  try {
    database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(testProjectIds.project);
    const insertRoot = database.prepare(`
      INSERT INTO workbench_project_roots(project_id, root_id, root_index, name, relative_path, root_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertRoot.run(testProjectIds.project, "removed", 0, "removed", "removed", "C:/removed");
    insertRoot.run(testProjectIds.project, "active", 1, "active", "active", "C:/active");
    const repository = new WorkbenchStatsImportRepository(database);
    const discovery = (rootId: string, name: string, observedAt: number) => ({
      checkpointCommit: "a".repeat(40),
      checkpointRef: `refs/worktree/agents/codex/thread/checkpoints/${name}`,
      harness: "codex",
      observedAt,
      projectId: testProjectIds.project,
      repositoryRoot: `C:/${rootId}`,
      rootId,
      threadId: "thread",
      workspaceRoot: `C:/${rootId}`,
    });
    const completed = discovery("removed", "completed", 4);
    const removedFailure = discovery("removed", "removed-failed", 3);
    const activeFailure = discovery("active", "active-failed", 2);
    const removedProcessing = discovery("removed", "processing", 1);
    const removedPending = discovery("removed", "pending", 0);
    repository.addClaimDiscoveries("first", [completed, removedFailure, activeFailure, removedProcessing, removedPending], 1);
    for (const [expected, state] of [
      [completed, "completed"], [removedFailure, "failed"], [activeFailure, "failed"],
    ] as const) {
      const candidate = repository.claimClaims("first", 2);
      assert.equal(candidate?.checkpointRef, expected.checkpointRef);
      repository.settleClaims("first", candidate!, state === "completed"
        ? { paths: ["src/file.ts"], state }
        : { error: "spawn git ENOENT", state }, 3);
    }
    assert.equal(repository.claimClaims("first", 3)?.checkpointRef, removedProcessing.checkpointRef);

    database.prepare("DELETE FROM workbench_project_roots WHERE project_id = ? AND root_id = 'removed'").run(testProjectIds.project);
    repository.addClaimDiscoveries("second", [activeFailure], 4);

    const retried = repository.claimClaims("second", 5);
    assert.equal(retried?.checkpointRef, activeFailure.checkpointRef);
    assert.equal(repository.claimClaims("second", 6), null);
    assert.deepEqual(database.prepare("SELECT checkpoint_ref, state FROM git_claim_imports ORDER BY checkpoint_ref").all(), [
      { checkpoint_ref: completed.checkpointRef, state: "completed" },
      { checkpoint_ref: activeFailure.checkpointRef, state: "processing" },
    ].sort((left, right) => left.checkpoint_ref.localeCompare(right.checkpoint_ref)));
    assert.deepEqual(database.prepare("SELECT claimed_path FROM git_claim_thread_file_days").all(), [
      { claimed_path: "src/file.ts" },
    ]);
  } finally { database.close(); }
});

test("usage schema v10 preserves pricing context while discarding v1 token facts", () => {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database, { targetVersion: 9 });
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
  database.exec(`
    INSERT INTO thread_turn_usage VALUES
      ('turn', 'gpt-5.4', 'standard', 100, 80, 0, 20, 5, 120, 1, 2);
    INSERT INTO thread_usage_imports VALUES
      ('project', 'codex', 'provider-thread', 'completed', NULL, 1, 1, 2, 2, 2, 2, NULL);
  `);
  try {
    installWorkbenchDatabaseSchema(database, { targetVersion: 10 });
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
    INSERT INTO workbench_projects(id) VALUES ('${testProjectIds.project}');
    INSERT INTO workbench_threads
      (id, project_id, project_root, title, transcript_content_version,
       created_at, updated_at, activity_at, next_turn_index)
    VALUES ('thread', '${testProjectIds.project}', 'C:/project', 'thread', 1, 1, 1, 1, 1);
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
    INSERT INTO thread_usage_imports
      (project_id, harness_id, provider_thread_id, state, run_id, attempt_count, discovered_at,
       source_activity_at, started_at, settled_at, updated_at, error_text, completed_data_version)
    VALUES ('${testProjectIds.project}', 'codex', 'provider-thread', 'completed', NULL, 1, 1, 2, 2, 2, 2, NULL, 1);
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
    `).get() as { completed_data_version: number }).completed_data_version, WORKBENCH_STATS_USAGE_IMPORT_VERSION);

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
    `).get(), { completed_data_version: WORKBENCH_STATS_USAGE_IMPORT_VERSION, state: "unavailable" });

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
    database.prepare("UPDATE thread_usage_imports SET completed_data_version = 2").run();
    repository.beginUsage("context-backfill", ["codex"], 30);
    assert.ok(repository.claimUsage("context-backfill", ["codex"], 31));
    assert.deepEqual(database.prepare(`
      SELECT cumulative_total_tokens, usage_data_version FROM thread_turn_usage WHERE turn_id = 'turn'
    `).get(), { cumulative_total_tokens: 120, usage_data_version: 2 });
  } finally {
    database.close();
  }
});
