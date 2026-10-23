/*
 * No production exports. Tests protect history index freshness through triggers and background backfill, the
 * narrative/detail split workspace search relies on, retained narrative, and archive exclusion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { compileWorkbenchDatabaseStatement } from "workbench-shared/database/workbench-database-statements";

import { transformCoreTranscriptItem } from "../transcript/workbench-transcript-core-transformers";
import { workbenchDatabaseTables } from "../workbench-database-schema";
import WorkbenchHistoryIndex, { purgeArchivedSearchNarrative, retainSearchNarrative } from "./WorkbenchHistoryIndex";
import { createSearchTestDatabase, placeSearchThread, seedSearchThread } from "../search/search.test.fixtures";

test("narrative written before or after the index exists is found, edits replace old words and deletes remove them", () => {
  const database = createSearchTestDatabase();
  try {
    seedSearchThread(database, { id: "older", title: "Older", userText: "quartz lantern", assistantText: "copper kettle" });
    const index = new WorkbenchHistoryIndex(database);
    // Edited after the triggers exist but before backfill reaches it: the backfill must not duplicate or resurrect text.
    database.prepare("UPDATE thread_item_assistant_messages SET text = 'brass kettle'").run();
    seedSearchThread(database, { id: "newer", title: "Newer", userText: "velvet lantern", assistantText: "tin drum" });
    assert.equal(index.matchThreads('"quartz"').size, 0, "matches never finish backfill inline");
    while (index.backfillStep());

    assert.deepEqual([...index.matchThreads('"lantern"').keys()].sort(), ["newer", "older"]);
    assert.deepEqual([...index.matchThreads('"brass"').keys()], ["older"]);
    assert.equal(index.matchThreads('"copper"').size, 0);
    assert.equal(index.readMessage(index.matchThreads('"brass"').get("older")!.messageKey)?.text, "brass kettle");

    database.prepare("UPDATE thread_user_message_parts SET text = 'quartz candle' WHERE text = 'quartz lantern'").run();
    assert.deepEqual([...index.matchThreads('"lantern"').keys()], ["newer"]);
    database.prepare("DELETE FROM workbench_threads WHERE id = 'newer'").run();
    assert.equal(index.matchThreads('"velvet"').size, 0);
    assert.deepEqual(index.vocabularyContaining("ndl"), ["candle"]);
  } finally { database.close(); }
});

test("tool text is indexed for history search but never matches workspace narrative", () => {
  const database = createSearchTestDatabase();
  try {
    seedSearchThread(database, { id: "tooling", title: "Tooling", userText: "run it", assistantText: "done" });
    const index = new WorkbenchHistoryIndex(database);
    const { turn_id: turnId } = database.prepare("SELECT turn_id FROM thread_items LIMIT 1").get() as { turn_id: string };
    const publicId = "00000000-0000-4000-8000-000000000099";
    database.prepare("INSERT INTO workbench_transcript_item_identities(id, thread_id) VALUES (?, 'tooling')").run(publicId);
    database.prepare(`INSERT INTO thread_items(id, public_id, thread_id, turn_id, item_position, type, created_at, updated_at)
      VALUES (99, ?, 'tooling', ?, 99, 'functionCallOutput', 1, 1)`).run(publicId, turnId);
    database.prepare("INSERT INTO thread_item_tool_outputs(item_id, name, body_kind, body_text) VALUES (99, 'shell', 'text', 'zeppelin output')").run();
    assert.equal(index.matchThreads('"zeppelin"').size, 0);
    assert.ok(index.vocabularyContaining("eppel").includes("zeppelin"));
    assert.deepEqual(index.vocabularyContaining("eppel", { narrative: true }), []);
  } finally { database.close(); }
});

test("transcript upserts of an indexed message never abort the writer and reindex it", () => {
  const database = createSearchTestDatabase();
  try {
    const index = new WorkbenchHistoryIndex(database);
    seedSearchThread(database, { id: "streamed", title: "Streamed", userText: "amber query", assistantText: "first draft" });
    assert.deepEqual([...index.matchThreads('"draft"').keys()], ["streamed"]);
    const { item_id: itemId } = database.prepare("SELECT item_id FROM thread_item_assistant_messages").get() as { item_id: number };
    const upsertAgentText = (text: string) => {
      const transform = transformCoreTranscriptItem({
        itemId, lifecycle: "completed",
        item: { id: "streamed-assistant", delivery: null, questions: null, memoryCitation: null, phase: "commentary", text, type: "agentMessage" },
      } as Parameters<typeof transformCoreTranscriptItem>[0])!;
      for (const mutation of transform.mutations) {
        const compiled = compileWorkbenchDatabaseStatement(workbenchDatabaseTables, mutation);
        database.prepare(compiled.sql).run(...compiled.parameters);
      }
    };
    // Same key marked by OLD and NEW in one upsert, then again while still dirty.
    upsertAgentText("second answer");
    upsertAgentText("third answer");
    assert.equal(index.matchThreads('"draft"').size, 0);
    assert.deepEqual([...index.matchThreads('"third"').keys()], ["streamed"]);
  } finally { database.close(); }
});

test("retained narrative outlives expired items, then dies with archiving and never shows archived threads", () => {
  const database = createSearchTestDatabase();
  try {
    seedSearchThread(database, { id: "settled", title: "Settled", userText: "walrus plan", assistantText: "walrus answer" });
    seedSearchThread(database, { id: "archived", title: "Archived", userText: "walrus secret", assistantText: "hidden" });
    placeSearchThread(database, "settled", { archived: false });
    placeSearchThread(database, "archived", { archived: true });
    const index = new WorkbenchHistoryIndex(database);
    while (index.backfillStep());
    assert.deepEqual([...index.matchThreads('"walrus"').keys()], ["settled"]);

    database.transaction(() => {
      retainSearchNarrative(database, "SELECT id FROM thread_turns", []);
      database.prepare("DELETE FROM thread_items").run();
    })();
    assert.deepEqual(database.prepare("SELECT thread_id, role FROM workbench_search_narratives ORDER BY role").all(),
      [{ role: "assistant", thread_id: "settled" }, { role: "user", thread_id: "settled" }]);
    const retained = index.matchThreads('"plan"').get("settled");
    assert.deepEqual(index.readMessage(retained!.messageKey), { role: "user", text: "walrus plan" });
    const rebuilt = new WorkbenchHistoryIndex(database);
    while (rebuilt.backfillStep());
    assert.ok(rebuilt.matchThreads('"answer"').has("settled"), "a rebuilt index backfills retained text");

    database.prepare("UPDATE workbench_top_level_thread_states SET archived = 1 WHERE thread_id = 'settled'").run();
    assert.equal(index.matchThreads('"walrus"').size, 0);
    assert.equal(purgeArchivedSearchNarrative(database), 2);
    database.prepare("UPDATE workbench_top_level_thread_states SET archived = 0 WHERE thread_id = 'settled'").run();
    assert.equal(index.matchThreads('"walrus"').size, 0, "restoring from archive does not revive purged text");
  } finally { database.close(); }
});
