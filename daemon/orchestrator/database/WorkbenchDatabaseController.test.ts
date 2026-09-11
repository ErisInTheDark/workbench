/*
 * No production exports. Node tests protect the native worker lifecycle, exact schema inventory, transcript materialization, search, and relational discriminator constraints.
 */
import assert from "node:assert/strict";
import databaseReleases from "workbench-shared/workbench/database/schema/releases";
import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import WorkbenchTranscriptRepository from "./transcript/WorkbenchTranscriptRepository";
import WorkbenchDatabaseController, { WorkbenchDatabaseRequestFailure } from "./WorkbenchDatabaseController";
import {
  coreTables,
  installWorkbenchDatabaseSchema,
  threadStateTables,
  WORKBENCH_DATABASE_SCHEMA_VERSION,
  WORKBENCH_DATABASE_TABLE_NAMES,
} from "./workbench-database-schema";
import { insertRow, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { WorkbenchStatsDetailedResponseSchema, legacyStatsResponse } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import { preserveWorkbenchDatabaseBackup } from "workbench-shared/database/workbench-database-migration";
import { TranscriptQuerySchema } from "./transcript/transcript-query-contract";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  NativeThreadId: {
    "thread": fixtureIdentitySchemas.NativeThreadIdSchema.parse("thread"),
  },
  NativeTurnId: {
    "turn": fixtureIdentitySchemas.NativeTurnIdSchema.parse("turn"),
  },
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "active-thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("active-thread"),
    "settled-thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("settled-thread"),
    "thread": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
    "unadmitted": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("unadmitted"),
  },
  WorkbenchTurnId: {
    "active-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("active-turn"),
    "settled-turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("settled-turn"),
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  },
};

test("stored transcript queries cross the worker boundary and preserve invalid-id failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "transcript-query-worker-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    const page = await controller.queryTranscript(TranscriptQuerySchema.parse({ action: "stats" }));
    assert.equal(page.coverage.threads, 0);
    await assert.rejects(controller.queryTranscript(TranscriptQuerySchema.parse({ action: "read", threads: ["missing-wb-id"] })), /Unknown Workbench thread/u);
  } finally { await controller.close(); await rm(directory, { recursive: true, force: true }); }
});

test("worker migration waits for its owner to retain the rollback checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-migration-ack-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const version = databaseReleases.nativeIdentityLookupIndexes.version;
  const old = new Database(databasePath);
  installWorkbenchDatabaseSchema(old, { targetVersion: version });
  old.close();
  const options = {
    databasePath,
    beforeMigration: (_backupPath: string) => { throw new Error("rollback checkpoint was not retained"); },
  };
  const controller = new WorkbenchDatabaseController(options);
  try {
    await assert.rejects(controller.start(), /rollback checkpoint was not retained/u);
  } finally {
    await controller.close();
    const inspection = new Database(databasePath, { readonly: true });
    try { assert.equal(inspection.pragma("user_version", { simple: true }), version); }
    finally { inspection.close(); }
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker startup retains its old-schema backup even when closed during opening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-migration-worker-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const version = databaseReleases.nativeIdentityLookupIndexes.version;
  const old = new Database(databasePath);
  installWorkbenchDatabaseSchema(old, { targetVersion: version });
  old.exec("CREATE TABLE preserved_extension(value TEXT); INSERT INTO preserved_extension VALUES ('retained')");
  old.close();
  const controller = new WorkbenchDatabaseController({ databasePath });
  try {
    const started = controller.start();
    const closed = controller.close();
    await started;
    await closed;
    const backups = join(directory, "backups", "workbench.sqlite3");
    const files = await readdir(backups).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.equal(files.length, 1, "worker readiness requires a pre-upgrade backup");
    const backup = new Database(join(backups, files[0]!), { readonly: true, fileMustExist: true });
    try {
      assert.equal(backup.pragma("user_version", { simple: true }), version);
      assert.deepEqual(backup.prepare("SELECT value FROM preserved_extension").get(), { value: "retained" });
    } finally {
      backup.close();
    }
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed relational database upgrades without losing its saved profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-profile-upgrade-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const old = new Database(databasePath);
  installWorkbenchDatabaseSchema(old, { targetVersion: databaseReleases.relationalThreadState.version });
  old.prepare("INSERT INTO workbench_thread_state_import(id, completed_at) VALUES (1, ?)").run(1);
  old.exec(`
    INSERT INTO workbench_harnesses(id) VALUES ('codex');
    INSERT INTO workbench_project_thread_profiles
      (project_id, selection_kind, profile_id, harness_id, model, reasoning_effort, service_tier, agent_path, agent_source)
    VALUES ('project', 'profile', 'saved-profile', 'codex', 'retained-model', 'high', 'fast', NULL, NULL)
  `);
  const before = old.prepare("SELECT * FROM workbench_project_thread_profiles").get();
  old.close();
  const controller = new WorkbenchDatabaseController({ databasePath });
  try {
    const inventory = await controller.start();
    assert.equal(inventory.schemaVersion, databaseReleases.profileContextWindows.version);
    await controller.close();
    const upgraded = new Database(databasePath);
    try {
      assert.deepEqual(upgraded.prepare("SELECT * FROM workbench_project_thread_profiles").get(), {
        ...before as Record<string, string | null>,
        context_window_tokens: null,
      });
      upgraded.prepare("UPDATE workbench_project_thread_profiles SET context_window_tokens = ?").run(500_000);
      assert.deepEqual(upgraded.prepare("SELECT context_window_tokens FROM workbench_project_thread_profiles").get(), {
        context_window_tokens: 500_000,
      });
      assert.deepEqual(upgraded.prepare("SELECT completed_at FROM workbench_thread_state_import WHERE id = 1").get(), {
        completed_at: 1,
      });
    } finally { upgraded.close(); }
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the database worker opens, proves readiness, reports all tables, and closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const controller = new WorkbenchDatabaseController({ databasePath });
  let reopened: WorkbenchDatabaseController | null = null;
  try {
    const [inventory, coalescedInventory, implicitInventory] = await Promise.all([
      controller.start(),
      controller.start(),
      controller.getInventory(),
    ]);
    assert.equal(controller.state, "ready");
    assert.deepEqual(inventory.tableNames, [...WORKBENCH_DATABASE_TABLE_NAMES].sort());
    assert.equal(inventory.schemaVersion, WORKBENCH_DATABASE_SCHEMA_VERSION);
    assert.deepEqual(coalescedInventory, inventory);
    assert.deepEqual(implicitInventory, inventory);
    const catalog = ["first", "second"].map((nativeThreadId) => ({
      native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId) },
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), projectRoot: "C:/project", title: nativeThreadId,
      createdAt: 1, updatedAt: 2, activityAt: 2,
    }));
    const identities = await controller.observeThreadIdentities(catalog);
    assert.equal(identities.length, 2);
    assert.notEqual(identities[0]!.threadId, identities[1]!.threadId);
    assert.deepEqual(await controller.query(selectRows(coreTables.threadTurns)), []);
    await controller.close();
    assert.equal(controller.state, "closed");
    await assert.rejects(controller.start(), /closed/);
    await assert.rejects(controller.getInventory(), /closed/);
    const releasedDatabasePath = `${databasePath}.released`;
    await rename(databasePath, releasedDatabasePath);
    await rename(releasedDatabasePath, databasePath);

    const inspection = new Database(databasePath);
    try {
      assert.equal(inspection.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(inspection.pragma("user_version", { simple: true }), WORKBENCH_DATABASE_SCHEMA_VERSION);
      const readinessRows = inspection.prepare(
        "SELECT COUNT(*) AS count FROM workbench_harnesses WHERE id LIKE 'workbench-readiness-%'",
      ).get() as { count: number };
      assert.equal(readinessRows.count, 0);
    } finally {
      inspection.close();
    }

    reopened = new WorkbenchDatabaseController({ databasePath });
    assert.deepEqual(await reopened.getInventory(), inventory);
    assert.deepEqual(await reopened.observeThreadIdentities(catalog), identities);
    assert.deepEqual(await reopened.resolveNativeThreadIdentity(catalog[0]!.native), identities[0]);
    await reopened.close();
  } finally {
    await reopened?.close();
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a suspended database resumes the same worker and queued reads after rollback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-suspend-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const controller = new WorkbenchDatabaseController({ databasePath });
  try {
    const initial = await controller.start();
    await controller.suspend();
    const queued = controller.getInventory();
    const external = new Database(databasePath);
    external.close();
    await controller.resume();
    assert.deepEqual(await queued, initial);
    assert.deepEqual(await controller.getInventory(), initial);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retirement releases suspended callers before dependant disposal closes the worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-retire-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  let queued: Promise<unknown> | undefined;
  try {
    await controller.start();
    await controller.suspend();
    queued = controller.getInventory();
    void queued.catch(() => {});
    controller.retireSuspendedAdmission();
    await assert.rejects(queued, /retired/u);
    await assert.rejects(controller.getInventory(), /retired/u);
    assert.equal(controller.state, "suspended", "Retirement admission must not prematurely dispose the worker");
  } finally {
    await controller.close();
    await queued?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("the retained worker restores both schema and data before releasing queued callers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-worker-schema-rollback-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const controller = new WorkbenchDatabaseController({ databasePath });
  try {
    const inventory = await controller.start();
    await controller.suspend();
    const candidate = new Database(databasePath);
    let checkpoint: string;
    try {
      candidate.exec("CREATE TABLE rollback_evidence(legacy TEXT); INSERT INTO rollback_evidence VALUES ('retained')");
      checkpoint = await preserveWorkbenchDatabaseBackup(candidate, join(directory, "rollback"));
      candidate.exec("DROP TABLE rollback_evidence; CREATE TABLE candidate_only(value TEXT)");
      candidate.pragma(`user_version = ${inventory.schemaVersion + 1}`);
    } finally { candidate.close(); }
    const queued = controller.getInventory();
    await controller.resume(checkpoint);
    const restoredInventory = await queued;
    assert.equal(restoredInventory.schemaVersion, inventory.schemaVersion);
    assert.equal(restoredInventory.tableNames.includes("candidate_only"), false);
    const inspection = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(inspection.prepare("SELECT legacy FROM rollback_evidence").all(), [{ legacy: "retained" }]);
    } finally { inspection.close(); }
    await controller.suspend();
    await controller.resume();
    assert.deepEqual(await controller.getInventory(), restoredInventory);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("retiring a suspended database rejects queued work instead of hanging it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-retire-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    await controller.start();
    await controller.suspend();
    const rejected = assert.rejects(controller.getInventory(), /closed|retired/u);
    await controller.close();
    await rejected;
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("database worker records claim snapshots and returns bounded stats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-stats-database-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    const now = Date.UTC(2026, 8, 4, 12);
    await controller.recordStatsClaimSnapshot({
      harness: "codex",
      observedAt: now - 60_000,
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      roots: [{ paths: ["src"], rootId: "root" }],
      threadId: "thread",
    });
    const result = await controller.readStats({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "7d" }, now);
    assert.equal(result.claimHotspots[0]?.path, "src");
    assert.equal(result.claimHotspots[0]?.threadCount, 1);
    const detailed = WorkbenchStatsDetailedResponseSchema.parse(await controller.readStatsDetailed({
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), range: "7d", tokenTypes: [],
    }, now));
    assert.deepEqual(legacyStatsResponse(detailed), result);
    const claims = await controller.readClaimStats({
      projectId: fixtureIdentityValues.ProjectId["project"], range: "7d", file: { rootId: "root", path: "src" }, page: 1,
    }, now);
    assert.equal(claims.kind, "threads");
    if (claims.kind === "threads") assert.deepEqual(claims.rows.map(({ threadId }) => threadId), ["thread"]);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mixed-model schema addition preserves usage counters, attribution and unrelated thread history", () => {
  const database = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(database, { targetVersion: 14 });
    database.pragma("foreign_keys = ON");
    const repository = new WorkbenchTranscriptRepository(database);
    repository.settle([
      { kind: "thread", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], projectId: fixtureIdentityValues.ProjectId["project"], projectRoot: "C:/project", title: "thread", createdAt: 1, updatedAt: 1, activityAt: 1 },
      { kind: "turn", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], turnIndex: 0, harnessId: "codex", nativeLocation: "C:/project", nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"], nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"], state: "completed", createdAt: 1, startedAt: 1, endedAt: 2, durationMs: 1_000 },
      { kind: "turnTokenUsage", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], observedAt: 2, usageDataVersion: 2,
        cumulative: { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: 150 } },
    ]);
    database.prepare("INSERT INTO thread_usage_model_attributions (turn_id, model, source, policy_version, updated_at) VALUES ('turn', 'model', 'thread', 1, 2)").run();
    const beforeUsage = database.prepare("SELECT * FROM thread_turn_usage").get() as Record<string, string | number | null>;
    const beforeAttribution = database.prepare("SELECT * FROM thread_usage_model_attributions").all();
    const beforeTranscript = repository.read({ threadId: "thread", turnLimit: 1 });
    installWorkbenchDatabaseSchema(database);
    installWorkbenchDatabaseSchema(database);
    assert.deepEqual(database.prepare("SELECT * FROM thread_turn_usage").get(), { ...beforeUsage, model_is_mixed: 0 });
    assert.deepEqual(database.prepare("SELECT * FROM thread_usage_model_attributions").all(), beforeAttribution);
    assert.deepEqual(repository.read({ threadId: "thread", turnLimit: 1 }), {
      ...beforeTranscript,
      thread: { ...beforeTranscript!.thread, identity_origin: "legacy" },
      turns: beforeTranscript!.turns.map((turn) => ({ ...turn, identity_origin: "legacy" })),
    });
    repository.settle([{ kind: "turnUsageContext", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], observedAt: 3, model: "rerouted", serviceTier: null, modelChanged: true }]);
    assert.deepEqual(database.prepare("SELECT model, model_is_mixed, cumulative_total_tokens FROM thread_turn_usage").get(), {
      model: "rerouted", model_is_mixed: 1, cumulative_total_tokens: 150,
    });
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("tool schema upgrade preserves collaboration children and callable sources", () => {
  const database = new Database(":memory:");
  try {
    installWorkbenchDatabaseSchema(database, { targetVersion: 11 });
    database.pragma("foreign_keys = ON");
    // Seed the historical schema directly; the current recorder requires the current schema.
    database.exec(`
      INSERT INTO workbench_harnesses(id) VALUES ('codex');
      INSERT INTO workbench_threads(id, project_id, project_root, title, transcript_content_version,
        next_turn_index, created_at, updated_at, activity_at)
        VALUES ('thread', 'project', 'C:/project', 'thread', 1, 1, 1, 1, 1);
      INSERT INTO thread_turns(id, thread_id, turn_index, harness_id, native_location, native_thread_id,
        native_turn_id, state, created_at, started_at, ended_at, duration_ms)
        VALUES ('turn', 'thread', 0, 'codex', 'C:/project', 'thread', 'turn', 'completed', 1, 1, 2, 1000);
      INSERT INTO thread_turn_materializations(turn_id, thread_id, materialized_at) VALUES ('turn', 'thread', 2);
      INSERT INTO thread_items(id, source_id, thread_id, turn_id, item_position, type, created_at, updated_at)
        VALUES (1, 'collab', 'thread', 'turn', 0, 'operation', 2, 2),
          (2, 'callable', 'thread', 'turn', 1, 'operation', 2, 2);
      INSERT INTO thread_item_operations(item_id, source_kind, source_revision) VALUES (1, 'tool', 0), (2, 'tool', 0);
      INSERT INTO thread_operation_tool_sources(item_id, source_revision, tool_kind, state, tool_name, duration_ms)
        VALUES (1, 0, 'collaboration', 'completed', 'spawnAgent', NULL),
          (2, 0, 'callable', 'completed', 'lookup', 1);
      INSERT INTO thread_operation_collaboration_tool_sources(item_id, source_revision, state, tool_name, sender_thread_id, prompt)
        VALUES (1, 0, 'completed', 'spawnAgent', 'thread', 'task');
      INSERT INTO thread_collaboration_receivers(item_id, receiver_index, receiver_thread_id) VALUES (1, 0, 'child');
      INSERT INTO thread_collaboration_agent_states(item_id, agent_thread_id, status) VALUES (1, 'child', 'running');
      INSERT INTO thread_operation_callable_tool_sources(item_id, source_revision, state, tool_name, callable_kind, arguments_json, success)
        VALUES (2, 0, 'completed', 'lookup', 'dynamic', '{}', 1);
      INSERT INTO thread_callable_dynamic_content(item_id, content_index, source_revision, content_kind, text)
        VALUES (2, 0, 0, 'inputText', 'result');
    `);
    const sourceTables = [
      "thread_operation_tool_sources", "thread_operation_collaboration_tool_sources",
      "thread_collaboration_receivers", "thread_collaboration_agent_states",
    ];
    const before = sourceTables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY item_id`).all());
    installWorkbenchDatabaseSchema(database);
    assert.deepEqual(sourceTables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY item_id`).all()), before);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    const repository = new WorkbenchTranscriptRepository(database);
    repository.settle([{
      kind: "item", threadId: fixtureIdentityValues.WorkbenchThreadId["thread"], turnId: fixtureIdentityValues.WorkbenchTurnId["turn"], lifecycle: "completed", observedAt: 3,
      item: {
        type: "collabAgentToolCall", id: "interrupted", tool: "sendMessage", status: "interrupted",
        senderThreadId: "thread", receiverThreadIds: ["child"], prompt: null, model: null, reasoningEffort: null, agentsStates: {},
      },
    }]);
    assert.equal(repository.read({ threadId: "thread", turnLimit: 10 })?.rows.threadItems.length, 3);
  } finally {
    database.close();
  }
});

test("schema version 4 thread-state rows migrate into the scoped relationship model", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database, { targetVersion: 4 });
    database.prepare(`
      INSERT INTO workbench_thread_state_projection_status(
        id, generation, state, source_project_count, source_project_updated_at,
        source_subagent_parent_count, source_subagent_count, source_digest,
        projected_thread_count, projected_subagent_count, mismatch_count,
        completed_at, error_text, updated_at
      ) VALUES (1, 4, 'failed', 1, 10, 1, 1, ?, 2, 1, 0, NULL, 'Legacy failure', 10)
    `).run("a".repeat(64));
    database.exec(`
      INSERT INTO workbench_thread_state_threads VALUES
        ('parent', 'project', 'topLevel', 'visible', 'Parent', 0, 0, 0, 1, 1, 2, 2, NULL),
        ('historical-child', 'project', 'subagent', 'visible', 'Child', 0, 0, 0, 1, 1, 2, 2, NULL);
      INSERT INTO workbench_thread_state_provider_identities
        VALUES ('historical-child', 'codex', 'historical-child');
      INSERT INTO workbench_thread_state_subagents
        VALUES ('historical-child', 'subagent', 'parent', 'C:/project', 'child', 'child', 'profile', 'Profile', 0);
    `);

    installWorkbenchDatabaseSchema(database, { targetVersion: 5 });
    database.exec(`
      INSERT INTO workbench_thread_state_subagent_parents
        VALUES ('parent-scope', 'project', 'codex', 'parent', 2);
      INSERT INTO workbench_thread_state_subagent_relationships
        VALUES ('reservation', 'parent-scope', 'pending', 'reserved-child', 1, 1, 2);
      INSERT INTO workbench_thread_state_pending_subagent_relationships
        VALUES ('reservation', 'pending', 'pending:6bca4a6a-9d20-4b7f-8a14-87ca3461b310',
          'C:/project', 'reserved-child', 'profile', 'Profile', 'Reserved');
      INSERT INTO workbench_thread_state_questionnaires
        VALUES ('old-questionnaire', 'parent', 'answered', 'turn', 'item', 'reusable-key',
          'request', 'Choose', '', 'Submit', NULL, NULL, 2);
      INSERT INTO workbench_thread_state_questionnaire_questions
        VALUES ('old-questionnaire', 0, 'choice', '', 'Continue?', 1, 0);
      INSERT INTO workbench_thread_state_questionnaire_options
        VALUES ('old-questionnaire', 0, 0, 'Yes', '');
      INSERT INTO workbench_thread_state_questionnaire_answers
        VALUES ('old-questionnaire', 'answered', 'choice', 0, 'Yes');
    `);
    installWorkbenchDatabaseSchema(database);
    installWorkbenchDatabaseSchema(database);

    assert.deepEqual(database.prepare(`
      SELECT reservation_id, name, profile_id FROM workbench_thread_state_pending_subagent_relationships
    `).get(), { reservation_id: "6bca4a6a-9d20-4b7f-8a14-87ca3461b310", name: "reserved-child", profile_id: "profile" });
    assert.deepEqual(database.prepare(`
      SELECT q.id, a.answer, o.label FROM workbench_thread_state_questionnaires q
      JOIN workbench_thread_state_questionnaire_answers a ON a.questionnaire_id = q.id
      JOIN workbench_thread_state_questionnaire_options o ON o.questionnaire_id = q.id
    `).all(), [{ id: "old-questionnaire", answer: "Yes", label: "Yes" }]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);

    assert.equal(database.pragma("user_version", { simple: true }), WORKBENCH_DATABASE_SCHEMA_VERSION);
    assert.deepEqual(database.prepare(`
      SELECT project_id, provider_thread_id
      FROM workbench_thread_state_provider_identities
    `).get(), { project_id: "project", provider_thread_id: "historical-child" });
    assert.deepEqual(database.prepare(`
      SELECT error_code, error_text
      FROM workbench_thread_state_projection_status
    `).get(), { error_code: "projection-failure", error_text: "Legacy failure" });
    assert.doesNotThrow(() => database.exec(`
      INSERT INTO workbench_thread_state_threads VALUES
        ('replacement-child', 'project', 'subagent', 'visible', 'Replacement', 0, 0, 0, 1, 3, 4, 4, NULL);
      INSERT INTO workbench_thread_state_subagents
        VALUES ('replacement-child', 'subagent', 'parent', 'C:/project', 'child', 'child', 'profile', 'Profile', 0);
    `));
    assert.equal((database.prepare(`
      SELECT COUNT(*) count
      FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'workbench_thread_state_%_subagent_relationships'
    `).get() as { count: number }).count, 2);
  } finally {
    database.close();
  }
});

test("schema constraints reject invalid thread state and mismatched item augmentations", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    assert.throws(() => database.prepare(`
      INSERT INTO workbench_threads(
        id,project_id,project_root,title,archived,pinned,snoozed,transcript_content_version,
        next_turn_index,created_at,updated_at,activity_at
      ) VALUES ('thread','project','C:/project','title',1,1,0,1,0,1,1,1)
    `).run(), /CHECK constraint failed/);

    database.prepare("INSERT INTO workbench_harnesses(id) VALUES ('codex')").run();
    database.prepare(`
      INSERT INTO workbench_threads(
        id,project_id,project_root,title,transcript_content_version,created_at,updated_at,activity_at
      ) VALUES ('thread','project','C:/project','title',1,1,1,1)
    `).run();
    database.prepare(`
      INSERT INTO thread_turns(
        id,thread_id,turn_index,harness_id,native_location,native_thread_id,state,created_at,started_at
      ) VALUES ('turn','thread',0,'codex','C:/project','native','inProgress',1,1)
    `).run();
    database.prepare(`
      INSERT INTO thread_turns(
        id,thread_id,turn_index,harness_id,native_location,native_thread_id,state,created_at
      ) VALUES ('terminal-without-provider-times','thread',1,'codex','C:/project','native','completed',1)
    `).run();
    const itemId = Number(database.prepare(`
      INSERT INTO thread_items(source_id,thread_id,turn_id,item_position,type,created_at,updated_at)
      VALUES ('item','thread','turn',0,'plan',1,1)
    `).run().lastInsertRowid);
    assert.throws(
      () => database.prepare("INSERT INTO thread_item_assistant_messages(item_id,state,phase,text) VALUES (?,'completed','commentary','nope')").run(itemId),
      /FOREIGN KEY constraint failed/,
    );

    const operationId = Number(database.prepare(`
      INSERT INTO thread_items(source_id,thread_id,turn_id,item_position,type,created_at,updated_at)
      VALUES ('operation','thread','turn',1,'operation',1,1)
    `).run().lastInsertRowid);
    database.prepare("INSERT INTO thread_item_operations(item_id,source_kind,source_revision) VALUES (?,'tool',2)").run(operationId);
    assert.throws(() => database.prepare(`
      INSERT INTO thread_operation_tool_sources(item_id,source_revision,tool_kind,state,tool_name)
      VALUES (?,1,'callable','completed','test')
    `).run(operationId), /FOREIGN KEY constraint failed/);

    database.prepare(`
      INSERT INTO thread_operation_tool_sources(item_id,source_revision,tool_kind,state,tool_name)
      VALUES (?,2,'callable','completed','test')
    `).run(operationId);
    assert.throws(() => database.prepare(`
      INSERT INTO thread_operation_callable_tool_sources(
        item_id,source_revision,state,tool_name,callable_kind,server_name,arguments_json
      ) VALUES (?,2,'completed','test','dynamic','mcp-only','{}')
    `).run(operationId), /CHECK constraint failed/);

    const processId = Number(database.prepare(`
      INSERT INTO thread_items(source_id,thread_id,turn_id,item_position,type,created_at,updated_at)
      VALUES ('process','thread','turn',2,'operation',1,1)
    `).run().lastInsertRowid);
    database.prepare("INSERT INTO thread_item_operations(item_id,source_kind,source_revision) VALUES (?,'process',0)").run(processId);
    database.prepare(`
      INSERT INTO thread_operation_process_sources(item_id,source_revision,state,command,cwd)
      VALUES (?,0,'completed','cat file','C:/project')
    `).run(processId);
    assert.throws(() => database.prepare(`
      INSERT INTO thread_process_command_actions(item_id,action_index,action_kind,command,name,path,query)
      VALUES (?,0,'read','cat file',NULL,NULL,'illegal')
    `).run(processId), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});

test("startup failure is permanent until the controller is replaced", async () => {
  const missingParent = `missing-workbench-parent-${process.pid}-${Date.now()}`;
  const controller = new WorkbenchDatabaseController({ databasePath: join(tmpdir(), missingParent, "workbench.sqlite3") });
  await assert.rejects(controller.start(), /directory does not exist|unable to open database/i);
  assert.equal(controller.state, "failed");
  await assert.rejects(controller.start(), /directory does not exist|unable to open database/i);
  await controller.close();
  assert.equal(controller.state, "closed");
});

test("an unstarted database controller closes without initializing its worker", async () => {
  const controller = new WorkbenchDatabaseController({
    databasePath: join(tmpdir(), `workbench-database-never-opened-${process.pid}-${Date.now()}.sqlite3`),
  });
  await controller.close();
  assert.equal(controller.state, "closed");
  await assert.rejects(controller.start(), /closed/u);
});

test("typed statement transactions preserve stable rows and roll back incomplete domain writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-statements-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    await controller.executeTransaction([
      insertRow(coreTables.workbenchHarnesses, { id: "codex" }),
      insertRow(coreTables.workbenchHarnesses, { id: "opencode2" }),
    ]);
    assert.deepEqual(
      await controller.query(selectRows(coreTables.workbenchHarnesses, {
        orderBy: [{ column: "id" }],
      })),
      [{ id: "codex" }, { id: "opencode2" }],
    );

    const thread = {
      id: "thread",
      project_id: "project",
      project_root: "C:/project",
      title: "first",
      transcript_content_version: 1,
      created_at: 1,
      updated_at: 1,
      activity_at: 1,
    } as const;
    await controller.executeTransaction([insertRow(coreTables.workbenchThreads, thread)]);
    await controller.executeTransaction([
      upsertRow(coreTables.workbenchThreads, {
        ...thread,
        title: "renamed",
        updated_at: 2,
      }, {
        conflictColumns: ["id"],
        updateColumns: ["title", "updated_at"],
      }),
    ]);
    assert.deepEqual(
      await controller.query(selectRows(coreTables.workbenchThreads, { where: { id: "thread" } })),
      [{
        id: "thread",
        identity_origin: "legacy",
        project_id: "project",
        project_root: "C:/project",
        title: "renamed",
        archived: 0,
        pinned: 0,
        snoozed: 0,
        transcript_content_version: 1,
        next_turn_index: 0,
        created_at: 1,
        updated_at: 2,
        activity_at: 1,
      }],
    );

    await assert.rejects(controller.executeTransaction([
      insertRow(coreTables.workbenchPendingImportThreads, {
        thread_id: "thread",
        harness_id: "codex",
        native_location: "C:/project",
        native_thread_id: "native",
        discovered_at: 2,
        last_seen_at: 2,
      }),
      insertRow(coreTables.workbenchPendingImportThreads, {
        thread_id: "missing-thread",
        harness_id: "codex",
        native_location: "C:/project",
        native_thread_id: "other-native",
        discovered_at: 2,
        last_seen_at: 2,
      }),
    ]), (error) => error instanceof WorkbenchDatabaseRequestFailure && /FOREIGN KEY constraint failed/.test(error.message));
    assert.equal(controller.state, "ready");
    assert.doesNotThrow(() => controller.assertReady());
    assert.deepEqual(
      await controller.query(selectRows(coreTables.workbenchPendingImportThreads)),
      [],
    );
    assert.deepEqual((await controller.getInventory()).tableNames, [...WORKBENCH_DATABASE_TABLE_NAMES].sort());
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace search ranks relational sources and keeps settled transcript bodies asleep", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-search-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    const observations = [
      {
        kind: "thread" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
        projectRoot: "C:/project",
        title: "Active search thread",
        createdAt: 1,
        updatedAt: 10,
        activityAt: 10,
      },
      {
        kind: "turn" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["active-turn"],
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("active-native"),
        nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("active-turn"),
        state: "completed" as const,
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
      {
        kind: "item" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["active-turn"],
        lifecycle: "completed" as const,
        observedAt: 2,
        item: {
          clientId: "active-user",
          content: [{ text: "midvalue narwhal", text_elements: [], type: "text" as const }],
          id: "active-user",
          type: "userMessage" as const,
        },
      },
      {
        kind: "item" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["active-turn"],
        lifecycle: "completed" as const,
        observedAt: 3,
        item: {
          id: "active-commentary",
          delivery: null,
          questions: null,
          memoryCitation: null,
          phase: "commentary" as const,
          text: "lowvalue comet",
          type: "agentMessage" as const,
        },
      },
      {
        kind: "item" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["active-turn"],
        lifecycle: "completed" as const,
        observedAt: 4,
        item: {
          id: "active-final",
          delivery: null,
          questions: null,
          memoryCitation: null,
          phase: "final_answer" as const,
          text: "finalsecret",
          type: "agentMessage" as const,
        },
      },
      {
        kind: "thread" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
        projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
        projectRoot: "C:/project",
        title: "Settled archive",
        createdAt: 1,
        updatedAt: 9,
        activityAt: 9,
      },
      {
        kind: "turn" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["settled-turn"],
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse("settled-native"),
        nativeTurnId: fixtureIdentitySchemas.NativeTurnIdSchema.parse("settled-turn"),
        state: "completed" as const,
        createdAt: 1,
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
      },
      {
        kind: "item" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["settled-turn"],
        lifecycle: "completed" as const,
        observedAt: 2,
        item: {
          clientId: "settled-user",
          content: [{ text: "sleepyhidden badger", text_elements: [], type: "text" as const }],
          id: "settled-user",
          type: "userMessage" as const,
        },
      },
      {
        kind: "item" as const,
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["settled-turn"],
        lifecycle: "completed" as const,
        observedAt: 3,
        item: {
          id: "settled-commentary",
          delivery: null,
          questions: null,
          memoryCitation: null,
          phase: "commentary" as const,
          text: "sleepyhidden otter",
          type: "agentMessage" as const,
        },
      },
    ];
    await controller.settleTranscript([
      {
        kind: "canonicalWindow",
        contentVersion: 3,
        materializedTurnIds: [fixtureIdentityValues.WorkbenchTurnId["active-turn"]],
        observations: observations.filter((observation) => observation.threadId === "active-thread"),
        threadId: fixtureIdentityValues.WorkbenchThreadId["active-thread"],
      },
      {
        kind: "canonicalWindow",
        contentVersion: 3,
        materializedTurnIds: [fixtureIdentityValues.WorkbenchTurnId["settled-turn"]],
        observations: observations.filter((observation) => observation.threadId === "settled-thread"),
        threadId: fixtureIdentityValues.WorkbenchThreadId["settled-thread"],
      },
    ]);
    await controller.executeTransaction([
      insertRow(coreTables.workbenchThreadLifecycle, {
        agent_status: "completed",
        lifecycle_kind: "completed",
        reason: "agentCompleted",
        request_key: null,
        settled: 0,
        thread_id: "active-thread",
        turn_id: "active-turn",
        updated_at: 10,
      }),
      insertRow(coreTables.workbenchThreadLifecycle, {
        agent_status: "completed",
        lifecycle_kind: "completed",
        reason: "agentCompleted",
        request_key: null,
        settled: 1,
        thread_id: "settled-thread",
        turn_id: "settled-turn",
        updated_at: 9,
      }),
    ]);
    await controller.replaceSearchProjects([
      { id: "project", name: "Project", rootPath: "C:/project" },
      { id: "other", name: "Other project", rootPath: "C:/other" },
    ]);
    await controller.replaceSearchProjectFiles("project", ["src/lowestvalue-needle.ts"]);
    await controller.replaceSearchProjectFiles("other", ["src/other-only.ts"]);

    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "search" })).results[0]?.title, "Active search thread");
    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "narwhal" })).results[0]?.title, "Active search thread");
    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "comet" })).results[0]?.title, "Active search thread");
    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "settled archive" })).results[0]?.title, "Settled archive");
    assert.deepEqual((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "sleepyhidden" })).results, []);
    assert.deepEqual((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "finalsecret" })).results, []);
    assert.equal((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "\"lowestvalue\"" })).results[0]?.kind, "file");
    assert.deepEqual((await controller.search({ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), query: "other-only" })).results, []);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid thread-state commits stay request-scoped without poisoning worker readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-thread-state-failure-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    await assert.rejects(controller.commitThreadState({ records: [{
      entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentityValues.WorkbenchThreadId["unadmitted"] },
      title: "not committed", activityAt: 1, providerObserved: true,
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      profile: null, settledAt: null, gitHistoryCleanedAt: null, mcpGeneration: null, snoozedUntil: null,
    }] }));
    assert.equal(controller.state, "ready");
    assert.doesNotThrow(() => controller.assertReady());

    assert.deepEqual(await controller.readThreadStateRecords({ selection: "project", projectId: fixtureIdentityValues.ProjectId["project"] }), []);
    assert.equal(await controller.readThreadStateActivity(fixtureIdentityValues.ProjectId["project"]), null);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed rollback checkpoint can be retried through the retained database worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-rollback-retry-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    const inventory = await controller.start();
    await controller.suspend();
    await assert.rejects(controller.resume(join(directory, "missing-checkpoint.sqlite3")));
    await assert.rejects(controller.getInventory());
    await controller.resume();
    assert.deepEqual(await controller.getInventory(), inventory);
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal transcript turns may preserve missing native timestamps without poisoning readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-database-native-turns-"));
  const controller = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    assert.deepEqual(
      await controller.readTranscriptMaterializedTurnIds("thread", ["turn", "missing"]),
      [],
    );
    await controller.settleTranscript([{
      kind: "canonicalWindow",
      contentVersion: 3,
      materializedTurnIds: [fixtureIdentityValues.WorkbenchTurnId["turn"]],
      threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
      observations: [
      {
        kind: "thread",
        threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
        projectId: fixtureIdentityValues.ProjectId["project"],
        projectRoot: "C:/project",
        title: "Thread",
        createdAt: 1,
        updatedAt: 1,
        activityAt: 1,
      },
      {
        kind: "turn",
        threadId: fixtureIdentityValues.WorkbenchThreadId["thread"],
        turnId: fixtureIdentityValues.WorkbenchTurnId["turn"],
        turnIndex: 0,
        harnessId: "codex",
        nativeLocation: "C:/project",
        nativeThreadId: fixtureIdentityValues.NativeThreadId["thread"],
        nativeTurnId: fixtureIdentityValues.NativeTurnId["turn"],
        state: "completed",
        createdAt: 1,
        startedAt: null,
        endedAt: null,
        durationMs: null,
      },
      ],
    }]);
    assert.equal(controller.state, "ready");
    assert.deepEqual(
      await controller.readTranscriptMaterializedTurnIds("thread", ["missing", "turn", "turn"]),
      ["turn"],
    );
    assert.deepEqual(
      (await controller.readTranscript({ threadId: "thread", turnLimit: 1 }))?.turns.map((turn) => ({
        state: turn.state,
        started_at: turn.started_at,
        ended_at: turn.ended_at,
      })),
      [{ state: "completed", started_at: null, ended_at: null }],
    );
  } finally {
    await controller.close();
    await rm(directory, { recursive: true, force: true });
  }
});
