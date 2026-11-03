/*
 * No production exports. Tests pinned instruction layers: base and prefix replace together, skills merge per path, and rows follow their thread.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema.ts";
import WorkbenchThreadInstructionOverlayStore from "./WorkbenchThreadInstructionOverlayStore.ts";

test("base pins replace with their prefix, skill pins merge per path, and a deleted thread takes its pins with it", () => {
  const database = new Database(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(database);
    database.prepare("INSERT INTO workbench_projects(id) VALUES (?)").run(testProjectIds.project);
    database.prepare(`INSERT INTO workbench_threads
      (id, project_id, project_root, title, transcript_content_version, created_at, updated_at, activity_at)
      VALUES ('thread', ?, 'C:/project', 'thread', 1, 1, 1, 1)`).run(testProjectIds.project);
    const store = new WorkbenchThreadInstructionOverlayStore(database);
    const layer = (name: string) => ({ checklists: [], modes: [{ name }] });

    assert.equal(store.execute({ kind: "read", threadId: "thread" }), null);
    store.execute({ kind: "pinSkills", threadId: "thread", skills: { a: layer("A1") }, at: 1 });
    store.execute({ kind: "pinBase", threadId: "thread", layers: [layer("Old")], prefix: { hash: "old" }, at: 2 });
    store.execute({ kind: "pinBase", threadId: "thread", layers: [layer("New")], prefix: { hash: "new" }, at: 3 });
    store.execute({ kind: "pinSkills", threadId: "thread", skills: { a: layer("A2"), b: layer("B") }, at: 4 });
    assert.deepEqual(store.execute({ kind: "read", threadId: "thread" }), {
      base: [layer("New")], skills: { a: layer("A2"), b: layer("B") }, prefix: { hash: "new" },
    });

    database.prepare("DELETE FROM workbench_threads WHERE id = 'thread'").run();
    assert.equal(store.execute({ kind: "read", threadId: "thread" }), null);
  } finally { database.close(); }
});
