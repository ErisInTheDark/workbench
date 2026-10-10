/* No production exports. Tests protect exact payload cutoffs, settlement ownership, compact aggregation, and retry safety. */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import type { WorkbenchTranscriptAtomicObservation } from "../transcript/workbench-transcript-types.ts";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchTranscriptRepository from "../transcript/WorkbenchTranscriptRepository.ts";
import { projectWorkbenchTranscript } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import WorkbenchTranscriptRetentionRepository from "./WorkbenchTranscriptRetentionRepository.ts";

function seed(database: Database.Database, threadId: string, settledAt: number | null) {
  database.prepare("INSERT OR IGNORE INTO workbench_projects(id) VALUES (?)").run(testProjectIds.project);
  database.prepare("INSERT OR IGNORE INTO workbench_harnesses(id) VALUES ('codex')").run();
  database.prepare(`INSERT INTO workbench_threads
    (id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at)
    VALUES (?, ?, 'C:/project', 'thread', 1, 1, 1, 1)`).run(threadId, testProjectIds.project);
  database.prepare(`INSERT INTO workbench_thread_states
    (thread_id, thread_kind, harness_id, title, activity_at, provider_observed)
    VALUES (?, 'topLevel', 'codex', 'thread', 1, 1)`).run(threadId);
  database.prepare(`INSERT INTO workbench_top_level_thread_states
    (thread_id, thread_kind, archived, pinned, snoozed)
    VALUES (?, 'topLevel', 0, 0, 0)`).run(threadId);
  database.prepare("INSERT INTO workbench_thread_retention(thread_id, settled_at) VALUES (?, ?)").run(threadId, settledAt);
}

function processItem(
  database: Database.Database,
  input: { threadId: string; turnId: string; itemId: number; createdAt: number; state: string; output: string },
) {
  database.prepare(`INSERT INTO thread_turns
    (id, thread_id, turn_index, harness_id, native_location, native_thread_id, state, created_at)
    VALUES (?, ?, 0, 'codex', 'C:/project', ?, 'completed', ?)`)
    .run(input.turnId, input.threadId, input.threadId, input.createdAt);
  database.prepare(`INSERT INTO thread_turn_materializations(turn_id, thread_id, materialized_at)
    VALUES (?, ?, ?)`).run(input.turnId, input.threadId, input.createdAt);
  const publicId = `item-${input.itemId}`;
  database.prepare("INSERT INTO workbench_transcript_item_identities(id, thread_id) VALUES (?, ?)")
    .run(publicId, input.threadId);
  database.prepare(`INSERT INTO thread_items
    (id, public_id, thread_id, turn_id, item_position, type, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'operation', ?, ?)`)
    .run(input.itemId, publicId, input.threadId, input.turnId, input.createdAt, input.createdAt);
  database.prepare(`INSERT INTO thread_item_operations(item_id, source_kind, source_revision)
    VALUES (?, 'process', 0)`).run(input.itemId);
  database.prepare(`INSERT INTO thread_operation_process_sources
    (item_id, source_revision, state, command, cwd, output_text)
    VALUES (?, 0, ?, 'echo', 'C:/project', ?)`).run(input.itemId, input.state, input.output);
}

test("result expiry preserves the call envelope, honours exact cutoffs, and aggregates once", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    seed(database, "old", null);
    seed(database, "boundary", null);
    seed(database, "running", null);
    processItem(database, { threadId: "old", turnId: "old-turn", itemId: 1, createdAt: 99, state: "completed", output: "large" });
    processItem(database, { threadId: "boundary", turnId: "boundary-turn", itemId: 2, createdAt: 100, state: "completed", output: "keep" });
    processItem(database, { threadId: "running", turnId: "running-turn", itemId: 3, createdAt: 1, state: "inProgress", output: "streaming" });
    const repository = new WorkbenchTranscriptRetentionRepository(database);

    assert.deepEqual(repository.expire({ expiredAt: 1_000, resultCutoff: 100, transcriptCutoff: 0 }), {
      expiredResults: 1, expiredTurns: 0,
    });
    assert.deepEqual(database.prepare(`SELECT item_id, output_text FROM thread_operation_process_sources ORDER BY item_id`).all(), [
      { item_id: 1, output_text: null },
      { item_id: 2, output_text: "keep" },
      { item_id: 3, output_text: "streaming" },
    ]);
    assert.deepEqual(database.prepare("SELECT item_id, expired_at FROM thread_item_payload_retention").all(), [
      { item_id: 1, expired_at: 1_000 },
    ]);
    assert.deepEqual(database.prepare("SELECT tool_name, call_count, failure_count FROM thread_tool_daily_aggregates").all(), []);
    const snapshot = new WorkbenchTranscriptRepository(database).read({ threadId: "old", turnLimit: 1 });
    assert.ok(snapshot);
    const projection = projectWorkbenchTranscript(snapshot);
    assert.ok(projection.success);
    const expiredItem = projection.data.turns[0]?.items[0];
    assert.equal(expiredItem?.type, "commandExecution");
    assert.equal(expiredItem?.type === "commandExecution" ? expiredItem.resultExpiredAt : null, 1_000);
    assert.equal(repository.expire({ expiredAt: 2_000, resultCutoff: 100, transcriptCutoff: 0 }).expiredResults, 0);
  } finally { database.close(); }
});

test("later result expiry epochs never revisit earlier payload cohorts", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    seed(database, "earlier", null);
    seed(database, "later", null);
    processItem(database, {
      threadId: "earlier", turnId: "earlier-turn", itemId: 1,
      createdAt: 10, state: "completed", output: "earlier payload",
    });
    const repository = new WorkbenchTranscriptRetentionRepository(database);
    assert.equal(repository.expire({
      expiredAt: 1_000, resultCutoff: 20, transcriptCutoff: 0,
    }).expiredResults, 1);
    processItem(database, {
      threadId: "later", turnId: "later-turn", itemId: 2,
      createdAt: 30, state: "completed", output: "later payload",
    });
    database.exec(`
      CREATE TRIGGER reject_earlier_payload_revisit
      BEFORE UPDATE OF output_text ON thread_operation_process_sources
      WHEN OLD.item_id = 1
      BEGIN
        SELECT RAISE(FAIL, 'earlier payload cohort revisited');
      END;
    `);

    assert.equal(repository.expire({
      expiredAt: 2_000, resultCutoff: 40, transcriptCutoff: 0,
    }).expiredResults, 1);
    assert.deepEqual(database.prepare(`
      SELECT item_id, expired_at FROM thread_item_payload_retention ORDER BY item_id
    `).all(), [
      { item_id: 1, expired_at: 1_000 },
      { item_id: 2, expired_at: 2_000 },
    ]);
  } finally { database.close(); }
});

test("settled transcript expiry keeps turn identity and removes only generations older than the cutoff", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    seed(database, "expired", 99);
    seed(database, "boundary", 100);
    processItem(database, { threadId: "expired", turnId: "expired-turn", itemId: 1, createdAt: 90, state: "completed", output: "old" });
    processItem(database, { threadId: "boundary", turnId: "boundary-turn", itemId: 2, createdAt: 90, state: "completed", output: "keep" });
    database.prepare(`INSERT INTO transcript_native_records
      (link_kind, thread_id, turn_id, item_id, harness_id, native_location, native_thread_id,
        record_kind, payload_json, recorded_at)
      VALUES ('turn', 'expired', 'expired-turn', NULL, 'codex', 'C:/project', 'expired',
        'snapshot', '{"large":"expired"}', 90),
      ('turn', 'boundary', 'boundary-turn', NULL, 'codex', 'C:/project', 'boundary',
        'snapshot', '{"large":"keep"}', 90)`).run();

    const result = new WorkbenchTranscriptRetentionRepository(database)
      .expire({ expiredAt: 1_000, resultCutoff: 0, transcriptCutoff: 100 });

    assert.deepEqual(result, { expiredResults: 0, expiredTurns: 1 });
    assert.deepEqual(database.prepare("SELECT id FROM thread_turns ORDER BY id").all(), [
      { id: "boundary-turn" }, { id: "expired-turn" },
    ]);
    assert.deepEqual(database.prepare("SELECT turn_id, expired_at FROM thread_turn_payload_retention").all(), [
      { turn_id: "expired-turn", expired_at: 1_000 },
    ]);
    assert.deepEqual(database.prepare("SELECT thread_id FROM thread_items").all(), [{ thread_id: "boundary" }]);
    assert.deepEqual(database.prepare("SELECT thread_id, payload_json FROM transcript_native_records").all(), [
      { thread_id: "boundary", payload_json: '{"large":"keep"}' },
    ]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("result expiry removes every supported result family while preserving invocation facts", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    seed(database, "families", null);
    processItem(database, {
      threadId: "families", turnId: "families-turn", itemId: 1,
      createdAt: 10, state: "completed", output: "process body",
    });
    const threadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("families");
    const turnId = fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("families-turn");
    const item = (
      value: Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["item"],
    ): WorkbenchTranscriptAtomicObservation => ({
      kind: "item", threadId, turnId, lifecycle: "completed", observedAt: 10, item: value,
    });
    const repository = new WorkbenchTranscriptRepository(database);
    repository.settle([
      item({
        type: "mcpToolCall", id: "mcp", server: "wb", tool: "rg", arguments: { args: ["needle"] },
        status: "completed", result: {
          content: [{ type: "text", text: "mcp body" }],
          structuredContent: { rows: [1] }, _meta: { source: "test" },
        },
        error: null, durationMs: 3, appContext: null, pluginId: null, readOnlyHint: true,
      }),
      item({
        type: "mcpToolCall", id: "mcp-empty", server: "wb", tool: "empty", arguments: {},
        status: "completed", result: null, error: null, durationMs: 2,
        appContext: null, pluginId: null, readOnlyHint: true,
      }),
      item({
        type: "dynamicToolCall", id: "dynamic", namespace: "test", tool: "lookup",
        arguments: { query: "needle" }, status: "completed", contentItems: [
          { type: "inputText", text: "dynamic body" },
        ], success: true, durationMs: 4, toolCallGroupId: null, metadata: null,
      }),
      item({
        type: "functionCallOutput", id: "function", name: "lookup", namespace: "test",
        output: [{ type: "input_text", text: "function body" }],
      }),
    ]);

    assert.deepEqual(new WorkbenchTranscriptRetentionRepository(database).expire({
      expiredAt: 1_000, resultCutoff: 100, transcriptCutoff: 0,
    }), { expiredResults: 4, expiredTurns: 0 });
    assert.equal(database.prepare("SELECT COUNT(*) FROM thread_callable_mcp_results").pluck().get(), 0);
    assert.equal(database.prepare("SELECT COUNT(*) FROM thread_callable_dynamic_content").pluck().get(), 0);
    assert.equal(database.prepare("SELECT COUNT(*) FROM thread_tool_output_parts").pluck().get(), 0);
    assert.deepEqual(
      database.prepare("SELECT body_kind, body_text FROM thread_item_tool_outputs").get(),
      { body_kind: "text", body_text: "" },
    );
    assert.deepEqual(database.prepare(`
      SELECT tool_name, call_count, failure_count FROM thread_tool_daily_aggregates
      ORDER BY tool_name
    `).all(), [{ tool_name: "rg", call_count: 1, failure_count: 0 }]);
    assert.equal(new WorkbenchTranscriptRetentionRepository(database).expire({
      expiredAt: 2_000, resultCutoff: 100, transcriptCutoff: 0,
    }).expiredResults, 0);
    assert.deepEqual(database.prepare(`
      SELECT tool_name, call_count, failure_count FROM thread_tool_daily_aggregates
      ORDER BY tool_name
    `).all(), [{ tool_name: "rg", call_count: 1, failure_count: 0 }]);

    const snapshot = repository.read({ threadId: "families", turnLimit: 1 });
    assert.ok(snapshot);
    const projection = projectWorkbenchTranscript(snapshot);
    assert.ok(projection.success);
    assert.deepEqual(projection.data.turns[0]?.items.map(candidate => ({
      type: candidate.type,
      resultExpiredAt: "resultExpiredAt" in candidate ? candidate.resultExpiredAt : null,
    })), [
      { type: "commandExecution", resultExpiredAt: 1_000 },
      { type: "mcpToolCall", resultExpiredAt: 1_000 },
      { type: "mcpToolCall", resultExpiredAt: null },
      { type: "dynamicToolCall", resultExpiredAt: 1_000 },
      { type: "functionCallOutput", resultExpiredAt: 1_000 },
    ]);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});
