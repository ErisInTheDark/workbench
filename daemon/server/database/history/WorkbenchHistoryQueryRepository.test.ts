/*
 * Exports: none. Behaviour tests for stored-history queries: items and narrative windows, ranked index-backed search,
 * scope, secrets, catalogues and the bounds that keep broad searches and expired turns cheap.
 */
import assert from "node:assert/strict";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchHistoryQueryRepository from "./WorkbenchHistoryQueryRepository";
import WorkbenchHistoryIndex from "./WorkbenchHistoryIndex";
import { HistoryQuerySchema, type HistoryQuery } from "./history-query-contract";

function itemPublicId(id: number) {
  return `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
}

function fixture() {
  const db = new Database(":memory:");
  installWorkbenchDatabaseSchema(db);
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO workbench_harnesses(id) VALUES ('codex')").run();
  for (const [index, id] of ["wb-one", "wb-two"].entries()) {
    const projectId = index === 0 ? testProjectIds.project : testProjectIds.other;
    db.prepare("INSERT INTO workbench_projects (id) VALUES (?)").run(projectId);
    db.prepare(`INSERT INTO workbench_threads(id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at, archived)
      VALUES (?, ?, ?, ?, 3, 1, 1, 1, 1)`).run(id, projectId, `/project-${index}`, id);
    db.prepare(`INSERT INTO thread_turns(id, thread_id, turn_index, harness_id, native_location, native_thread_id, state, created_at)
      VALUES (?, ?, 0, 'codex', '/', ?, 'completed', 1)`).run(`${id}-turn`, id, `native-${index}`);
  }
  db.prepare("INSERT INTO thread_turn_materializations(turn_id, thread_id, materialized_at) VALUES ('wb-one-turn', 'wb-one', 1)").run();
  const addRoot = (id: number, thread: string, reference: string, type: string, position = id) => {
    const publicId = itemPublicId(id);
    db.prepare("INSERT INTO workbench_transcript_item_identities(id, thread_id) VALUES (?, ?)").run(publicId, thread);
    db.prepare(`INSERT INTO workbench_transcript_item_source_aliases(
      turn_id, source_kind, reference, component_kind, component_index, thread_id, item_identity_id
    ) VALUES (?, 'stable', ?, 'item', 0, ?, ?)`).run(`${thread}-turn`, reference, thread, publicId);
    db.prepare(`INSERT INTO thread_items(id, public_id, thread_id, turn_id, item_position, type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, publicId, thread, `${thread}-turn`, position, type, id, id);
    return publicId;
  };
  const add = (id: number, thread: string, value: string, position = id) => {
    addRoot(id, thread, `source-${id}`, "assistantMessage", position);
    db.prepare("INSERT INTO thread_item_assistant_messages(item_id, state, phase, text) VALUES (?, 'completed', 'commentary', ?)").run(id, value);
  };
  add(1, "wb-one", "first 100%_literal Éclair");
  add(2, "wb-two", "second 100%_literal");
  add(3, "wb-one", "third needle");
  let index: WorkbenchHistoryIndex | null = null;
  const owned = () => index ??= new WorkbenchHistoryIndex(db);
  return {
    db,
    add,
    addRoot,
    read: (input: Partial<HistoryQuery>) => {
      const query = HistoryQuerySchema.parse({ action: "search", query: "100%_literal", ...input });
      // Everything except search must work on reader connections, which own no index.
      return query.action === "search" ? new WorkbenchHistoryQueryRepository(db, owned()).read(query) : new WorkbenchHistoryQueryRepository(db).read(query);
    },
    backfill: () => { while (owned().backfillStep()); },
  };
}

test("read exposes canonical item data rather than database field snippets", () => {
  const { db, read } = fixture();
  try {
    db.pragma("query_only = ON");
    const page = read({ action: "read", query: null, threads: ["wb-one"], limit: 1 });
    assert.equal(page.rows[0]?.kind, "commentary");
    assert.ok(page.rows[0]?.fields.some(field => field.value === "commentary"));
    assert.ok(page.rows[0]?.fields.some(field => field.value === "third needle"));
  } finally { db.close(); }
});

test("read trims long content while keeping item metadata available", () => {
  const { db, read } = fixture();
  try {
    db.prepare("UPDATE thread_item_assistant_messages SET text = ? WHERE item_id = 3").run("message ".repeat(300));
    const fields = read({ action: "read", query: null, threads: ["wb-one"], limit: 1 }).rows[0]!.fields;
    assert.ok(fields.some(field => field.value === "commentary"));
    assert.ok(fields.some(field => typeof field.value === "string"
      && field.value.startsWith("message ") && field.value.length < 200 && field.length! > field.value.length));
  } finally { db.close(); }
});

test("search isolates wb ids and projects, folds case and accents, and reports incomplete storage", () => {
  const { db, read, backfill } = fixture();
  try {
    backfill();
    db.prepare("INSERT INTO thread_turn_payload_retention(turn_id, expired_at) VALUES ('wb-two-turn', 5)").run();
    const page = read({ threads: ["wb-one"] });
    assert.deepEqual(page.rows.map(row => row.threadId), ["wb-one"]);
    assert.equal(page.coverage.materializedTurns, 1);
    assert.equal(read({ threads: ["wb-two"] }).coverage.expiredTurns, 1);
    assert.equal(read({ threads: ["wb-one"], project: testProjectIds.other }).rows.length, 0);
    assert.throws(() => read({ threads: ["native-0"] }), /thread/i);
    assert.equal(read({ query: "éCLAIR" }).rows.length, 1);
    assert.equal(read({ query: "100XXliteral" }).rows.length, 0);
    assert.equal(read({ query: "100%_literal -first" }).rows.length, 1);
  } finally { db.close(); }
});

test("search matches words in any order, ranks items holding more terms first and counts every term", () => {
  const { db, read, add, backfill } = fixture();
  try {
    add(10, "wb-one", "gamma alpha beta");
    add(11, "wb-one", "alpha only");
    add(12, "wb-one", "beta gamma");
    backfill();
    const page = read({ query: "beta alpha zeta" });
    assert.equal(page.rows[0]?.id, itemPublicId(10));
    assert.deepEqual(page.search?.terms.map(term => [term.term, term.hits]), [["beta", 2], ["alpha", 2], ["zeta", 0]]);
    assert.equal(page.search?.complete, 0);
    assert.equal(page.search?.partial, 3);
    const both = read({ query: "alpha gamma" });
    assert.equal(both.search?.complete, 1);
    assert.equal(both.rows[0]?.id, itemPublicId(10));
  } finally { db.close(); }
});

test("search finds identifier fragments, corrects misspellings and keeps punctuated phrases exact", () => {
  const { db, read, add, backfill } = fixture();
  try {
    add(10, "wb-one", "WorkbenchThreadRecallController broke");
    add(11, "wb-one", "call foo.bar(x) here");
    add(12, "wb-one", "foo bar baz");
    add(13, "wb-one", "the approval gate");
    backfill();
    assert.equal(read({ query: "recall" }).rows[0]?.id, itemPublicId(10));
    const corrected = read({ query: "approvel" });
    assert.deepEqual(corrected.search?.corrections, [{ from: "approvel", to: "approval" }]);
    assert.equal(corrected.rows[0]?.id, itemPublicId(13));
    assert.deepEqual(read({ query: "\"foo.bar(\"" }).rows.map(row => row.id), [itemPublicId(11)]);
  } finally { db.close(); }
});

test("a broad search returns one bounded page with counts for every match instead of walking history", () => {
  const { db, read, add, backfill } = fixture();
  try {
    db.transaction(() => { for (let id = 10; id < 1_610; id++) add(id, "wb-one", `common word ${id}`); })();
    backfill();
    const page = read({ query: "common", limit: 5 });
    assert.equal(page.rows.length, 5);
    assert.equal(page.search?.terms[0]?.hits, 1_600);
    assert.ok(page.nextCursor);
  } finally { db.close(); }
});

test("search sees writes after the index exists and reports unfinished backfill instead of finishing it inline", () => {
  const { db, read, add } = fixture();
  try {
    assert.equal(read({ query: "needle" }).search?.indexed, 0);
    add(10, "wb-one", "fresh needle");
    assert.deepEqual(read({ query: "needle" }).rows.map(row => row.id), [itemPublicId(10)]);
  } finally { db.close(); }
});

test("search cursors exclude new inserts and reject changed filters", () => {
  const { db, read, add, backfill } = fixture();
  try {
    add(10, "wb-one", "shared word one");
    add(11, "wb-one", "shared word two");
    backfill();
    const first = read({ query: "shared", limit: 1 });
    assert.ok(first.nextCursor);
    add(12, "wb-one", "shared word inserted");
    const second = read({ query: "shared", limit: 1, cursor: first.nextCursor });
    assert.deepEqual([...first.rows, ...second.rows].map(row => row.id).sort(), [itemPublicId(10), itemPublicId(11)]);
    assert.equal(second.nextCursor, null);
    assert.throws(() => read({ query: "different", cursor: first.nextCursor }), /cursor/i);
  } finally { db.close(); }
});

test("read walks before, after and around an item in canonical order rather than by timestamps", () => {
  const { db, read, add } = fixture();
  try {
    for (let id = 10; id < 20; id++) add(id, "wb-one", `step ${id}`);
    db.prepare("UPDATE thread_items SET created_at = 9999 WHERE id = 1").run();
    const latest = read({ action: "read", query: null, threads: ["wb-one"], limit: 3 });
    assert.deepEqual(latest.rows.map(row => row.id), [17, 18, 19].map(itemPublicId));
    assert.equal(latest.older, true);
    const before = read({ action: "read", query: null, threads: ["wb-one"], limit: 2, before: itemPublicId(17) });
    assert.deepEqual(before.rows.map(row => row.id), [15, 16].map(itemPublicId));
    const after = read({ action: "read", query: null, threads: ["wb-one"], limit: 2, after: itemPublicId(17) });
    assert.deepEqual(after.rows.map(row => row.id), [18, 19].map(itemPublicId));
    assert.equal(after.newer, false);
    const around = read({ action: "read", query: null, threads: ["wb-one"], around: itemPublicId(12), context: 1 });
    assert.deepEqual(around.rows.map(row => row.id), [11, 12, 13].map(itemPublicId));
  } finally { db.close(); }
});

test("long expansion remains traversable with stale detection", () => {
  const { db, read } = fixture();
  try {
    db.prepare("UPDATE thread_item_assistant_messages SET text = ? WHERE item_id = 1").run("x".repeat(40000));
    const item = itemPublicId(1);
    let page = read({ action: "show", query: null, threads: ["wb-one"], item });
    const content = () => page.rows.flatMap(row => row.fields).filter(field => field.path[0] === "text").map(field => field.value).join("");
    let result = content();
    const stale = page.nextCursor;
    assert.ok(stale);
    while (page.nextCursor) {
      page = read({ action: "show", query: null, threads: ["wb-one"], item, cursor: page.nextCursor });
      result += content();
    }
    assert.equal(result, "x".repeat(40000));
    db.prepare("UPDATE thread_item_assistant_messages SET text = 'changed' WHERE item_id = 1").run();
    assert.throws(() => read({ action: "show", query: null, threads: ["wb-one"], item, cursor: stale }), /changed|stale/i);
  } finally { db.close(); }
});

test("secret answers are neither searchable nor revealed by expansion", () => {
  const { db, read, addRoot, backfill } = fixture();
  try {
    addRoot(10, "wb-one", "secret", "questionnaire");
    db.prepare(`INSERT INTO thread_item_interactions(item_id, item_type, thread_id, request_key, request_id, title, summary, submit_label, state, resolved_at)
      VALUES (10, 'questionnaire', 'wb-one', 'q', 'q', 'question', '', '', 'answered', 10)`).run();
    db.prepare(`INSERT INTO thread_interaction_questions(item_id, question_index, question_id, header, question, allow_other, is_secret)
      VALUES (10, 0, 'password', '', 'credential', 1, 1)`).run();
    db.prepare("INSERT INTO thread_interaction_answers(item_id, question_id, answer_index, answer) VALUES (10, 'password', 0, 'hiddenanswer')").run();
    backfill();
    assert.equal(read({ query: "hiddenanswer" }).rows.length, 0);
    assert.equal(read({ query: "hiddenanswer", opaque: true }).rows.length, 0);
    const found = read({ query: "credential" }).rows[0];
    assert.ok(found);
    for (const opaque of [false, true]) {
      const shown = read({ action: "show", query: null, threads: ["wb-one"], item: found.id, opaque });
      assert.ok(shown.rows[0]?.fields.some(field => field.value === "[redacted]"));
      assert.ok(shown.rows[0]?.fields.every(field => field.value !== "hiddenanswer"));
    }
  } finally { db.close(); }
});

test("tool filters, multipart outputs and opaque opt-in narrow search", () => {
  const { db, read, addRoot, backfill } = fixture();
  try {
    addRoot(10, "wb-one", "output", "functionCallOutput");
    db.prepare("INSERT INTO thread_item_tool_outputs(item_id, name, body_kind) VALUES (10, 'inspect', 'parts')").run();
    const part = db.prepare("INSERT INTO thread_tool_output_parts(item_id, part_index, part_type, text) VALUES (10, ?, 'text', ?)");
    part.run(0, "left needle");
    part.run(1, "right needle");
    addRoot(11, "wb-one", "patch", "fileChange");
    db.prepare("INSERT INTO thread_item_file_changes(item_id, state) VALUES (11, 'completed')").run();
    db.prepare("INSERT INTO thread_file_changes(item_id, change_index, path, change_kind, diff) VALUES (11, 0, 'src/owner.ts', 'update', '+replacement')").run();
    addRoot(12, "wb-one", "opaque", "unknown");
    db.prepare(`INSERT INTO thread_item_unknown(item_id, native_type, safe_json) VALUES (12, 'extension', '{"text":"opaquemarker"}')`).run();
    backfill();
    assert.equal(read({ query: "left right", tool: "inspect" }).search?.complete, 1);
    assert.equal(read({ query: "needle", tool: "other" }).rows.length, 0);
    assert.equal(read({ query: "replacement", file: "owner.ts" }).rows.length, 1);
    assert.equal(read({ query: "replacement", file: "other.ts" }).rows.length, 0);
    assert.equal(read({ query: "opaquemarker" }).rows.length, 0);
    assert.equal(read({ query: "opaquemarker", opaque: true }).rows.length, 1);
  } finally { db.close(); }
});

test("catalogues and stats preserve placement, coverage and exact turn selection", () => {
  const { db, read } = fixture();
  try {
    assert.equal(read({ action: "projects", query: null }).rows.length, 2);
    assert.deepEqual(read({ action: "threads", query: "one" }).rows.map(row => row.threadId), ["wb-one"]);
    assert.equal(read({ action: "threads", query: null, archived: false }).rows.length, 0);
    assert.equal(read({ action: "turns", query: null, threads: ["wb-one"] }).rows[0]?.counts.materialized, 1);
    assert.equal(read({ action: "stats", query: null, threads: ["wb-one"] }).rows[0]?.counts["kind.commentary"], 2);
    assert.throws(() => read({ action: "read", query: null, turn: "wb-two-turn", threads: ["wb-one"] }), /turn/i);
  } finally { db.close(); }
});

test("agent messages share one kind across text-envelope and tool-output delivery routes", () => {
  const { db, read, addRoot } = fixture();
  try {
    const envelope = createWorkbenchAgentMessageText({ message: "relay", senderName: "Fern", senderThreadId: "wb-two" });
    const userMessage = (id: number, inputKind: "initial" | "steer", text: string) => {
      addRoot(id, "wb-one", `user-${id}`, "userMessage");
      db.prepare("INSERT INTO thread_item_user_messages(item_id, delivery_state, input_kind) VALUES (?, 'delivered', ?)").run(id, inputKind);
      db.prepare("INSERT INTO thread_user_message_parts(item_id, part_index, part_type, text) VALUES (?, 0, 'text', ?)").run(id, text);
    };
    userMessage(10, "steer", envelope);
    userMessage(11, "initial", envelope);
    userMessage(12, "steer", "relay from the user");
    addRoot(13, "wb-one", "agent-output", "functionCallOutput");
    db.prepare(`INSERT INTO thread_item_tool_outputs(item_id, name, namespace, body_kind, body_text)
      VALUES (13, 'agent_message', 'workbench', 'text', ?)`).run(envelope);
    const kinds = (kind: HistoryQuery["kinds"][number]) => read({ action: "read", query: null, threads: ["wb-one"], kinds: [kind] })
      .rows.map(row => [row.id, row.kind]);
    assert.deepEqual(kinds("agent-message"), [10, 11, 13].map(id => [itemPublicId(id), "agent-message"]));
    assert.deepEqual(kinds("user-steer"), [[itemPublicId(12), "user-steer"]]);
    assert.deepEqual(kinds("tool-output"), []);
  } finally { db.close(); }
});

test("narrative reads show retained text of expired turns and report them apart from unmaterialised ones", () => {
  const { db, read, add } = fixture();
  try {
    db.prepare(`INSERT INTO thread_turns(id, thread_id, turn_index, harness_id, native_location, native_thread_id, state, created_at)
      VALUES ('wb-one-expired', 'wb-one', 1, 'codex', '/', 'native-0', 'completed', 2),
             ('wb-one-missing', 'wb-one', 2, 'codex', '/', 'native-0', 'completed', 3),
             ('wb-one-latest', 'wb-one', 3, 'codex', '/', 'native-0', 'completed', 4)`).run();
    db.prepare(`INSERT INTO thread_turn_materializations(turn_id, thread_id, materialized_at)
      VALUES ('wb-one-expired', 'wb-one', 1), ('wb-one-latest', 'wb-one', 1)`).run();
    db.prepare("INSERT INTO thread_turn_payload_retention(turn_id, expired_at) VALUES ('wb-one-expired', 5)").run();
    const retainedId = itemPublicId(50);
    db.prepare("INSERT INTO workbench_transcript_item_identities(id, thread_id) VALUES (?, 'wb-one')").run(retainedId);
    db.prepare(`INSERT INTO workbench_transcript_item_source_aliases(turn_id, source_kind, reference, component_kind, component_index, thread_id, item_identity_id)
      VALUES ('wb-one-expired', 'stable', 'gone', 'item', 0, 'wb-one', ?)`).run(retainedId);
    db.prepare("INSERT INTO workbench_search_narratives(item_public_id, thread_id, role, text) VALUES (?, 'wb-one', 'assistant', 'kept words')").run(retainedId);
    add(60, "wb-one", "newest words");
    db.prepare("UPDATE thread_items SET turn_id = 'wb-one-latest' WHERE id IN (3, 60)").run();
    const page = read({ action: "read", view: "narrative", query: null, threads: ["wb-one"] });
    assert.deepEqual(page.records.map(record => [record.text, record.retained]), [
      ["first 100%_literal Éclair", false], ["kept words", true], ["third needle", false], ["newest words", false],
    ]);
    assert.deepEqual(page.gaps, ["wb-one-missing"]);
    assert.deepEqual(page.expired, ["wb-one-expired"]);
  } finally { db.close(); }
});
