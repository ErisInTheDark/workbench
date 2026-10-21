/*
 * No production exports. Tests protect narrative index freshness through triggers and backfill, retained narrative, and archive exclusion.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { compileWorkbenchDatabaseStatement } from "workbench-shared/database/workbench-database-statements";

import { transformCoreTranscriptItem } from "../transcript/workbench-transcript-core-transformers";
import { workbenchDatabaseTables } from "../workbench-database-schema";
import WorkbenchSearchNarrativeIndex,{ purgeArchivedSearchNarrative, retainSearchNarrative } from "./WorkbenchSearchNarrativeIndex";
import { createSearchTestDatabase, placeSearchThread, seedSearchThread } from "./search.test.fixtures";

test("narrative written before or after the index exists is found, edits replace old words and deletes remove them", () => {
  const database = createSearchTestDatabase();
  try {
    seedSearchThread(database, { id: "older", title: "Older", userText: "quartz lantern", assistantText: "copper kettle" });
    const index = new WorkbenchSearchNarrativeIndex(database);
    // Edited after the triggers exist but before backfill reaches it: the backfill must not duplicate or resurrect text.
    database.prepare("UPDATE thread_item_assistant_messages SET text = 'brass kettle'").run();
    seedSearchThread(database, { id: "newer", title: "Newer", userText: "velvet lantern", assistantText: "tin drum" });

    assert.deepEqual([...index.match('"lantern"').keys()].sort(), ["newer", "older"]);
    assert.deepEqual([...index.match('"brass"').keys()], ["older"]);
    assert.equal(index.match('"copper"').size, 0);
    assert.equal(index.readMessage(index.match('"brass"').get("older")!.messageKey)?.text, "brass kettle");

    database.prepare("UPDATE thread_user_message_parts SET text = 'quartz candle' WHERE text = 'quartz lantern'").run();
    assert.deepEqual([...index.match('"lantern"').keys()], ["newer"]);
    database.prepare("DELETE FROM workbench_threads WHERE id = 'newer'").run();
    assert.equal(index.match('"velvet"').size, 0);
    assert.deepEqual(index.vocabularyContaining("ndl"), ["candle"]);
  } finally { database.close(); }
});

test("transcript upserts of an indexed message never abort the writer and reindex it", () => {
  const database = createSearchTestDatabase();
  try {
    const index = new WorkbenchSearchNarrativeIndex(database);
    seedSearchThread(database, { id: "streamed", title: "Streamed", userText: "amber query", assistantText: "first draft" });
    assert.deepEqual([...index.match('"draft"').keys()], ["streamed"]);
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
    assert.equal(index.match('"draft"').size, 0);
    assert.deepEqual([...index.match('"third"').keys()], ["streamed"]);
  } finally { database.close(); }
});

test("retained narrative outlives expired items, then dies with archiving and never shows archived threads", () => {
  const database = createSearchTestDatabase();
  try {
    seedSearchThread(database, { id: "settled", title: "Settled", userText: "walrus plan", assistantText: "walrus answer" });
    seedSearchThread(database, { id: "archived", title: "Archived", userText: "walrus secret", assistantText: "hidden" });
    placeSearchThread(database, "settled", { archived: false });
    placeSearchThread(database, "archived", { archived: true });
    const index = new WorkbenchSearchNarrativeIndex(database);
    assert.deepEqual([...index.match('"walrus"').keys()], ["settled"]);

    database.transaction(() => {
      retainSearchNarrative(database, "SELECT id FROM thread_turns", []);
      database.prepare("DELETE FROM thread_items").run();
    })();
    assert.deepEqual(database.prepare("SELECT thread_id, role FROM workbench_search_narratives ORDER BY role").all(),
      [{ role: "assistant", thread_id: "settled" }, { role: "user", thread_id: "settled" }]);
    const retained = index.match('"plan"').get("settled");
    assert.deepEqual(index.readMessage(retained!.messageKey), { role: "user", text: "walrus plan" });
    assert.ok(new WorkbenchSearchNarrativeIndex(database).match('"answer"').has("settled"), "a rebuilt index backfills retained text");

    database.prepare("UPDATE workbench_top_level_thread_states SET archived = 1 WHERE thread_id = 'settled'").run();
    assert.equal(index.match('"walrus"').size, 0);
    assert.equal(purgeArchivedSearchNarrative(database), 2);
    database.prepare("UPDATE workbench_top_level_thread_states SET archived = 0 WHERE thread_id = 'settled'").run();
    assert.equal(index.match('"walrus"').size, 0, "restoring from archive does not revive purged text");
  } finally { database.close(); }
});
