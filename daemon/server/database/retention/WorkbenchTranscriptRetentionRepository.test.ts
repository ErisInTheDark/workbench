/* No production exports. Tests protect exact payload cutoffs, latest-turn protection, settlement ownership, compact aggregation, retry safety, and retained search narrative. */
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
import { createSearchTestDatabase, placeSearchThread, seedSearchThread } from "../search/search.test.fixtures.ts";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";

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
    (thread_id, thread_kind, archived)
    VALUES (?, 'topLevel', 0)`).run(threadId);
  database.prepare("INSERT INTO workbench_thread_retention(thread_id, settled_at) VALUES (?, ?)").run(threadId, settledAt);
}

function turn(database: Database.Database, input: { threadId: string; turnId: string; turnIndex?: number; createdAt: number }) {
  database.prepare(`INSERT INTO thread_turns
    (id, thread_id, turn_index, harness_id, native_location, native_thread_id, state, created_at)
    VALUES (?, ?, ?, 'codex', 'C:/project', ?, 'completed', ?)`)
    .run(input.turnId, input.threadId, input.turnIndex ?? 0, input.threadId, input.createdAt);
  database.prepare(`INSERT INTO thread_turn_materializations(turn_id, thread_id, materialized_at)
    VALUES (?, ?, ?)`).run(input.turnId, input.threadId, input.createdAt);
}

function processItem(
  database: Database.Database,
  input: { threadId: string; turnId: string; turnIndex?: number; itemId: number; createdAt: number; state: string; output: string },
) {
  turn(database, input);
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

type FixtureItem = Extract<WorkbenchTranscriptAtomicObservation, { kind: "item" }>["item"];

function settleItems(database: Database.Database, threadId: string, turnId: string, observedAt: number, items: FixtureItem[]) {
  new WorkbenchTranscriptRepository(database).settle(items.map((item): WorkbenchTranscriptAtomicObservation => ({
    kind: "item",
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId),
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(turnId),
    lifecycle: "completed", observedAt, item,
  })));
}

function userMessage(id: string, text: string): FixtureItem {
  return { type: "userMessage", id, clientId: null, content: [{ type: "text", text, text_elements: [] }] };
}

/** Gives a thread a later meaningful turn so its earlier results are no longer the latest. */
function supersede(database: Database.Database, threadId: string) {
  const turnId = `${threadId}-next`;
  turn(database, { threadId, turnId, turnIndex: 1, createdAt: 50_000 });
  settleItems(database, threadId, turnId, 50_000, [userMessage(`${threadId}-ask`, "next ask")]);
}

test("observed settled transcripts survive until release while restored threads stay protected", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    for (const [index, threadId] of ["observed", "unobserved", "restored"].entries()) {
      seed(database, threadId, threadId === "restored" ? null : 1);
      processItem(database, {
        threadId, turnId: `${threadId}-turn`, itemId: index + 1, createdAt: 1, state: "completed", output: threadId,
      });
    }
    const owner = new WorkbenchTranscriptRetentionRepository(database);
    assert.equal(owner.expireTurnPayloads({
      expiredAt: 1_000, transcriptCutoff: 100, observedThreadIds: ["observed"],
    }, 10), 1);
    assert.deepEqual(database.prepare("SELECT thread_id FROM thread_items ORDER BY thread_id").pluck().all(), ["observed", "restored"]);
    assert.equal(owner.expireTurnPayloads({
      expiredAt: 2_000, transcriptCutoff: 100, observedThreadIds: [],
    }, 10), 1);
    assert.deepEqual(database.prepare("SELECT thread_id FROM thread_items").pluck().all(), ["restored"]);
  } finally { database.close(); }
});

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
    for (const threadId of ["old", "boundary", "running"]) supersede(database, threadId);
    const repository = new WorkbenchTranscriptRetentionRepository(database);

    assert.equal(repository.expireResultPayloads({ expiredAt: 1_000, resultCutoff: 100 }), 1);
    assert.deepEqual(database.prepare(`SELECT item_id, output_text FROM thread_operation_process_sources ORDER BY item_id`).all(), [
      { item_id: 1, output_text: null },
      { item_id: 2, output_text: "keep" },
      { item_id: 3, output_text: "streaming" },
    ]);
    assert.deepEqual(database.prepare("SELECT item_id, expired_at FROM thread_item_payload_retention").all(), [
      { item_id: 1, expired_at: 1_000 },
    ]);
    assert.deepEqual(database.prepare("SELECT tool_name, call_count, failure_count FROM thread_tool_daily_aggregates").all(), []);
    const snapshot = new WorkbenchTranscriptRepository(database).read({ threadId: "old", turnLimit: 2 });
    assert.ok(snapshot);
    const projection = projectWorkbenchTranscript(snapshot);
    assert.ok(projection.success);
    const expiredItem = projection.data.turns.flatMap(candidate => candidate.items).find(candidate => candidate.type === "commandExecution");
    assert.equal(expiredItem?.type, "commandExecution");
    assert.equal(expiredItem?.type === "commandExecution" ? expiredItem.resultExpiredAt : null, 1_000);
    assert.equal(repository.expireResultPayloads({ expiredAt: 2_000, resultCutoff: 100 }), 0);
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
    supersede(database, "earlier");
    const repository = new WorkbenchTranscriptRetentionRepository(database);
    assert.equal(repository.expireResultPayloads({ expiredAt: 1_000, resultCutoff: 20 }), 1);
    processItem(database, {
      threadId: "later", turnId: "later-turn", itemId: 20,
      createdAt: 30, state: "completed", output: "later payload",
    });
    supersede(database, "later");
    database.exec(`
      CREATE TRIGGER reject_earlier_payload_revisit
      BEFORE UPDATE OF output_text ON thread_operation_process_sources
      WHEN OLD.item_id = 1
      BEGIN
        SELECT RAISE(FAIL, 'earlier payload cohort revisited');
      END;
    `);

    assert.equal(repository.expireResultPayloads({ expiredAt: 2_000, resultCutoff: 40 }), 1);
    assert.deepEqual(database.prepare(`
      SELECT item_id, expired_at FROM thread_item_payload_retention ORDER BY item_id
    `).all(), [
      { item_id: 1, expired_at: 1_000 },
      { item_id: 20, expired_at: 2_000 },
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

    const repository = new WorkbenchTranscriptRetentionRepository(database);
    assert.equal(repository.expireResultPayloads({ expiredAt: 1_000, resultCutoff: 0 }), 2, "settled results expire regardless of age");
    assert.equal(repository.expireTurnPayloads({ expiredAt: 1_000, transcriptCutoff: 100 }, 10), 1);
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

test("turn expiry runs in bounded batches that together expire every eligible turn exactly once", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    for (let index = 1; index <= 5; index += 1) {
      seed(database, `thread-${index}`, 1);
      processItem(database, { threadId: `thread-${index}`, turnId: `turn-${index}`, itemId: index, createdAt: 1, state: "completed", output: "old" });
    }
    const repository = new WorkbenchTranscriptRetentionRepository(database);
    const cutoffs = { expiredAt: 1_000, transcriptCutoff: 100 };
    const remaining = () => database.prepare("SELECT COUNT(*) FROM thread_items").pluck().get();
    assert.equal(repository.expireTurnPayloads(cutoffs, 2), 2);
    assert.equal(remaining(), 3, "a batch leaves later turns untouched");
    assert.equal(repository.expireTurnPayloads(cutoffs, 2), 2);
    assert.equal(repository.expireTurnPayloads(cutoffs, 2), 1, "a short batch means nothing is left");
    assert.equal(repository.expireTurnPayloads(cutoffs, 2), 0);
    assert.equal(remaining(), 0);
    assert.equal(database.prepare("SELECT COUNT(*) FROM thread_turn_payload_retention WHERE expired_at = 1000").pluck().get(), 5);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally { database.close(); }
});

test("expiring settled transcripts keep their message text searchable until the thread is archived", () => {
  const database = createSearchTestDatabase();
  try {
    seedSearchThread(database, { id: "settled", title: "Settled", userText: "keep this ask", assistantText: "keep this answer" });
    seedSearchThread(database, { id: "archived", title: "Archived", userText: "drop this ask", assistantText: "drop this answer" });
    placeSearchThread(database, "settled", { archived: false, settledAt: 1 });
    placeSearchThread(database, "archived", { archived: true, settledAt: 1 });
    const retention = new WorkbenchTranscriptRetentionRepository(database);
    const retained = () => database.prepare("SELECT thread_id, role, text FROM workbench_search_narratives ORDER BY role").all();

    assert.equal(retention.expireTurnPayloads({ expiredAt: 1_000, transcriptCutoff: 100 }, 10), 2);
    assert.deepEqual(database.prepare("SELECT COUNT(*) FROM thread_items").pluck().get(), 0);
    assert.deepEqual(retained(), [
      { role: "assistant", text: "keep this answer", thread_id: "settled" },
      { role: "user", text: "keep this ask", thread_id: "settled" },
    ]);

    database.prepare("UPDATE workbench_top_level_thread_states SET archived = 1 WHERE thread_id = 'settled'").run();
    retention.expireResultPayloads({ expiredAt: 2_000, resultCutoff: 0 });
    assert.deepEqual(retained(), []);
  } finally { database.close(); }
});

test("result expiry removes every supported result family while preserving invocation facts", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    seed(database, "families", 1);
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

    assert.equal(new WorkbenchTranscriptRetentionRepository(database).expireResultPayloads({
      expiredAt: 1_000, resultCutoff: 100,
    }), 4);
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
    assert.equal(new WorkbenchTranscriptRetentionRepository(database).expireResultPayloads({
      expiredAt: 2_000, resultCutoff: 100,
    }), 0);
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

function expiredProcessIds(database: Database.Database) {
  return database.prepare(`
    SELECT retained.item_id FROM thread_item_payload_retention retained
    JOIN thread_operation_process_sources process ON process.item_id = retained.item_id
    ORDER BY retained.item_id
  `).pluck().all();
}

test("unsettled threads keep old results from their latest meaningful turn onwards, ignoring agent wake-up turns", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    seed(database, "wake", null);
    processItem(database, { threadId: "wake", turnId: "wake-0", turnIndex: 0, itemId: 1, createdAt: 10, state: "completed", output: "first" });
    processItem(database, { threadId: "wake", turnId: "wake-1", turnIndex: 1, itemId: 2, createdAt: 20, state: "completed", output: "latest" });
    turn(database, { threadId: "wake", turnId: "wake-2", turnIndex: 2, createdAt: 30 });
    settleItems(database, "wake", "wake-2", 30, [
      userMessage("incoming", createWorkbenchAgentMessageText({ message: "done", senderName: "Child", senderThreadId: "child" })),
      { type: "reasoning", id: "thinking", summary: [], content: ["nothing to do"] },
      {
        type: "mcpToolCall", id: "complete", server: "wb", tool: "task_completed", arguments: {},
        status: "completed", result: { content: [{ type: "text", text: "ok" }], structuredContent: null, _meta: null },
        error: null, durationMs: 1, appContext: null, pluginId: null, readOnlyHint: false,
      },
      { type: "agentMessage", id: "end", text: "<wb:end />", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
    ]);
    const repository = new WorkbenchTranscriptRetentionRepository(database);

    assert.equal(repository.expireResultPayloads({ expiredAt: 1_000, resultCutoff: 100 }), 1);
    assert.deepEqual(expiredProcessIds(database), [1]);

    turn(database, { threadId: "wake", turnId: "wake-3", turnIndex: 3, createdAt: 40 });
    settleItems(database, "wake", "wake-3", 40, [userMessage("ask", "carry on")]);
    assert.equal(repository.expireResultPayloads({ expiredAt: 2_000, resultCutoff: 100 }), 2, "the old latest turn and wake-up call expire");
    assert.deepEqual(expiredProcessIds(database), [1, 2]);
  } finally { database.close(); }
});

test("settled threads expire results regardless of age while unsettled results wait a day", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    seed(database, "settled", 5);
    seed(database, "open", null);
    processItem(database, { threadId: "settled", turnId: "settled-turn", itemId: 1, createdAt: 500, state: "completed", output: "fresh" });
    processItem(database, { threadId: "open", turnId: "open-turn", itemId: 2, createdAt: 500, state: "completed", output: "fresh" });
    supersede(database, "open");

    assert.equal(new WorkbenchTranscriptRetentionRepository(database).expireResultPayloads({ expiredAt: 1_000, resultCutoff: 100 }), 1);
    assert.deepEqual(expiredProcessIds(database), [1]);
  } finally { database.close(); }
});
