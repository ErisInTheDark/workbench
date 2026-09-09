/*
 * Keywords: transcript, sqlite, isolation, pagination, redaction.
 * Exports: none. Behaviour tests for stored-history queries.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchTranscriptQueryRepository from "./WorkbenchTranscriptQueryRepository";
import { TranscriptQuerySchema, type TranscriptQuery } from "./transcript-query-contract";

function fixture() {
  const db = new Database(":memory:");
  installWorkbenchDatabaseSchema(db);
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO workbench_harnesses(id) VALUES ('codex')").run();
  for (const [index, id] of ["wb-one", "wb-two"].entries()) {
    db.prepare(`INSERT INTO workbench_threads(id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at, archived)
      VALUES (?, ?, ?, ?, 3, 1, 1, 1, 1)`).run(id, `project-${index}`, `/project-${index}`, id);
    db.prepare(`INSERT INTO thread_turns(id, thread_id, turn_index, harness_id, native_location, native_thread_id, state, created_at)
      VALUES (?, ?, 0, 'codex', '/', ?, 'completed', 1)`).run(`${id}-turn`, id, `native-${index}`);
  }
  db.prepare("INSERT INTO thread_turn_materializations(turn_id, thread_id, materialized_at) VALUES ('wb-one-turn', 'wb-one', 1)").run();
  const add = (id: number, thread: string, value: string, position = id) => {
    db.prepare(`INSERT INTO thread_items(id, source_id, thread_id, turn_id, item_position, type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'assistantMessage', ?, ?)`).run(id, `source-${id}`, thread, `${thread}-turn`, position, id, id);
    db.prepare("INSERT INTO thread_item_assistant_messages(item_id, state, phase, text) VALUES (?, 'completed', 'commentary', ?)").run(id, value);
  };
  add(1, "wb-one", "first 100%_literal Éclair");
  add(2, "wb-two", "second 100%_literal");
  add(3, "wb-one", "third needle");
  return { db, add, read: (input: Partial<TranscriptQuery>) => new WorkbenchTranscriptQueryRepository(db).read(TranscriptQuerySchema.parse({ action: "search", queries: ["100%_literal"], ...input })) };
}

test("stored transcript queries isolate wb ids, include archived bodies and report incomplete storage without writing", () => {
  const { db, read } = fixture();
  try {
    db.pragma("query_only = ON");
    const page = read({ threads: ["wb-one"] });
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0]?.threadId, "wb-one");
    assert.equal(page.coverage.materializedTurns, 1);
    assert.equal(read({ threads: ["wb-two"] }).coverage.materializedTurns, 0);
    assert.equal(read({ threads: ["wb-one"], project: "project-1" }).rows.length, 0);
    assert.throws(() => read({ threads: ["native-0"] }), /thread/i);
    assert.equal(read({ queries: ["éCLAIR"] }).rows.length, 1);
    assert.equal(read({ queries: ["éCLAIR"], caseSensitive: true }).rows.length, 0);
    assert.equal(read({ queries: ["100XXliteral"] }).rows.length, 0);
    assert.equal(read({ queries: ["first", "Éclair"] }).rows.length, 1);
    assert.equal(read({ queries: ["first", "second"], any: true }).rows.length, 2);
    assert.equal(read({ excludes: ["first"] }).rows.length, 1);
  } finally { db.close(); }
});

test("query cursors preserve equal-time ordering, exclude new inserts and reject changed filters", () => {
  const { db, read, add } = fixture();
  try {
    const first = read({ queries: ["i"], limit: 1 });
    assert.equal(first.rows.length, 1);
    assert.ok(first.nextCursor);
    add(4, "wb-two", "new insertion");
    const ids = first.rows.map(row => row.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const next = read({ queries: ["i"], limit: 1, cursor });
      ids.push(...next.rows.map(row => row.id));
      cursor = next.nextCursor;
    }
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    assert.throws(() => read({ queries: ["different"], cursor: first.nextCursor }), /cursor/i);
  } finally { db.close(); }
});

test("history context follows turn positions and long expansion remains traversable with stale detection", () => {
  const { db, read } = fixture();
  try {
    const history = read({ action: "read", queries: [], threads: ["wb-one"] });
    assert.equal(history.rows.length, 2);
    const anchor = history.rows[0]!;
    const around = read({ action: "read", queries: [], threads: ["wb-one"], around: anchor.id, context: 1 });
    assert.deepEqual(around.rows.map(row => row.id), history.rows.map(row => row.id));
    db.prepare("UPDATE thread_item_assistant_messages SET text = ? WHERE item_id = 1").run("x".repeat(40000));
    let page = read({ action: "show", queries: [], threads: ["wb-one"], item: anchor.id });
    let result = page.rows.flatMap(row => row.fields).map(field => field.text).join("");
    const stale = page.nextCursor;
    assert.ok(stale);
    while (page.nextCursor) {
      page = read({ action: "show", queries: [], threads: ["wb-one"], item: anchor.id, cursor: page.nextCursor });
      result += page.rows.flatMap(row => row.fields).map(field => field.text).join("");
    }
    assert.equal(result, "x".repeat(40000));
    db.prepare("UPDATE thread_item_assistant_messages SET text = 'changed' WHERE item_id = 1").run();
    assert.throws(() => read({ action: "show", queries: [], threads: ["wb-one"], item: anchor.id, cursor: stale }), /changed|stale/i);
  } finally { db.close(); }
});

test("secret answers are neither searchable nor revealed by expansion", () => {
  const { db, read } = fixture();
  try {
    db.prepare(`INSERT INTO thread_items(id, source_id, thread_id, turn_id, item_position, type, created_at, updated_at)
      VALUES (10, 'secret', 'wb-one', 'wb-one-turn', 10, 'questionnaire', 10, 10)`).run();
    db.prepare(`INSERT INTO thread_item_interactions(item_id, item_type, thread_id, request_key, request_id, title, summary, submit_label, state, resolved_at)
      VALUES (10, 'questionnaire', 'wb-one', 'q', 'q', 'question', '', '', 'answered', 10)`).run();
    db.prepare(`INSERT INTO thread_interaction_questions(item_id, question_index, question_id, header, question, allow_other, is_secret)
      VALUES (10, 0, 'password', '', 'credential', 1, 1)`).run();
    db.prepare("INSERT INTO thread_interaction_answers(item_id, question_id, answer_index, answer) VALUES (10, 'password', 0, 'hidden-answer')").run();
    assert.equal(read({ queries: ["hidden-answer"] }).rows.length, 0);
    const found = read({ queries: ["credential"] }).rows[0];
    assert.ok(found);
    const shown = read({ action: "show", queries: [], threads: ["wb-one"], item: found.id });
    assert.ok(shown.rows[0]?.fields.some(field => field.text.includes("[redacted]")));
    assert.ok(shown.rows[0]?.fields.every(field => !field.text.includes("hidden-answer")));
  } finally { db.close(); }
});

test("item expansion honours intersecting project filters and packs small fields into one page", () => {
  const { db, read } = fixture();
  try {
    db.prepare(`INSERT INTO thread_items(id, source_id, thread_id, turn_id, item_position, type, created_at, updated_at)
      VALUES (10, 'process', 'wb-one', 'wb-one-turn', 10, 'operation', 10, 10)`).run();
    db.prepare("INSERT INTO thread_item_operations(item_id, source_kind, source_revision) VALUES (10, 'process', 0)").run();
    db.prepare(`INSERT INTO thread_operation_process_sources(item_id, source_revision, state, command, cwd, output_text, error_text)
      VALUES (10, 0, 'failed', 'run tool', '/work', 'output needle', 'error needle')`).run();
    const match = read({ queries: ["needle"], kinds: ["process"] }).rows[0]!;
    assert.ok(match);
    assert.throws(() => read({ action: "show", queries: [], threads: ["wb-one"], item: match.id, project: "project-1" }), /item|project/i);
    const shown = read({ action: "show", queries: [], threads: ["wb-one"], item: match.id });
    assert.equal(shown.nextCursor, null);
    assert.ok(shown.rows[0]?.fields.some(field => field.text === "output needle"));
    assert.ok(shown.rows[0]?.fields.some(field => field.text === "run tool"));
  } finally { db.close(); }
});

test("catalogues and stats preserve placement, coverage and exact turn selection", () => {
  const { db, read } = fixture();
  try {
    const projects = read({ action: "projects", queries: [] });
    assert.equal(projects.rows.length, 2);
    const threads = read({ action: "threads", queries: ["one"] });
    assert.deepEqual(threads.rows.map(row => row.threadId), ["wb-one"]);
    assert.equal(read({ action: "threads", queries: [], archived: false }).rows.length, 0);
    const turns = read({ action: "turns", queries: [], threads: ["wb-one"] });
    assert.equal(turns.rows[0]?.counts.materialized, 1);
    const stats = read({ action: "stats", queries: [], threads: ["wb-one"] });
    assert.equal(stats.rows[0]?.counts["kind.assistant-message"], 2);
    assert.throws(() => read({ turn: "wb-two-turn", threads: ["wb-one"] }), /turn/i);
  } finally { db.close(); }
});

test("multipart tool results and patches match once per item, with explicit opaque opt-in", () => {
  const { db, read } = fixture();
  try {
    const base = db.prepare(`INSERT INTO thread_items(id, source_id, thread_id, turn_id, item_position, type, created_at, updated_at)
      VALUES (?, ?, 'wb-one', 'wb-one-turn', ?, ?, 10, 10)`);
    base.run(10, "output", 10, "functionCallOutput");
    db.prepare("INSERT INTO thread_item_tool_outputs(item_id, name, body_kind) VALUES (10, 'inspect', 'parts')").run();
    const part = db.prepare("INSERT INTO thread_tool_output_parts(item_id, part_index, part_type, text) VALUES (10, ?, 'text', ?)");
    part.run(0, "left needle");
    part.run(1, "right needle");
    assert.equal(read({ queries: ["left", "right"], tool: "inspect" }).rows.length, 1);
    assert.equal(read({ queries: ["needle"], tool: "other" }).rows.length, 0);
    assert.equal(read({ queries: ["needle"], tool: "inspect" }).rows.length, 1);

    base.run(11, "patch", 11, "fileChange");
    db.prepare("INSERT INTO thread_item_file_changes(item_id, state) VALUES (11, 'completed')").run();
    db.prepare("INSERT INTO thread_file_changes(item_id, change_index, path, change_kind, diff) VALUES (11, 0, 'src/owner.ts', 'update', '+replacement')").run();
    assert.equal(read({ queries: ["replacement"], file: "owner.ts" }).rows.length, 1);
    assert.equal(read({ queries: ["replacement"], file: "other.ts" }).rows.length, 0);

    base.run(12, "opaque", 12, "unknown");
    db.prepare(`INSERT INTO thread_item_unknown(item_id, native_type, safe_json) VALUES (12, 'extension', '{"text":"opaque-marker"}')`).run();
    assert.equal(read({ queries: ["opaque-marker"] }).rows.length, 0);
    assert.equal(read({ queries: ["opaque-marker"], opaque: true }).rows.length, 1);
  } finally { db.close(); }
});

test("a sparse query yields resumable batches and follows canonical order rather than timestamps", () => {
  const { db, read, add } = fixture();
  try {
    db.transaction(() => {
      for (let index = 4; index < 220; index++) add(index, "wb-one", "unrelated");
    })();
    const first = read({ threads: ["wb-one"], queries: ["Éclair"] });
    assert.equal(first.rows.length, 0);
    assert.ok(first.nextCursor);
    const second = read({ threads: ["wb-one"], queries: ["Éclair"], cursor: first.nextCursor });
    assert.equal(second.rows.length, 1);
    assert.equal(second.nextCursor, null);
    db.prepare("UPDATE thread_items SET created_at = 9999 WHERE id = 1").run();
    const oldest = read({ action: "read", queries: [], threads: ["wb-one"], direction: "newer", limit: 1 });
    assert.equal(oldest.rows[0]?.id, "1");
  } finally { db.close(); }
});
