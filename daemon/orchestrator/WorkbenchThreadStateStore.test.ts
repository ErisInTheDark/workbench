/*
 * No production exports. Tests protect authoritative shared-worker thread-state document round trips, replacement, isolation, reopen durability, transcript-reset survival, and JSON constraints. Keywords: thread state, sqlite, authority, durability, test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import WorkbenchDatabaseController, { WorkbenchDatabaseRequestFailure } from "./database/WorkbenchDatabaseController";
import { threadStateTables } from "./database/workbench-database-schema";
import WorkbenchThreadStateStore, { type WorkbenchStoredThreadTitleHistory } from "./WorkbenchThreadStateStore";
import { insertRow } from "workbench-shared/database/workbench-database-statements";

test("title history updates and dismissals are isolated, atomic, and durable across reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-title-history-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const database = new WorkbenchDatabaseController({ databasePath });
  let reopened: WorkbenchDatabaseController | null = null;
  const history: WorkbenchStoredThreadTitleHistory[] = [{
    identity: { harness: "codex", threadId: "thread" },
    titles: [{ title: "new", usedAt: 20 }, { title: "old", usedAt: 10 }],
  }];
  try {
    const store = new WorkbenchThreadStateStore(database);
    const document = { drafts: [], records: [], version: 4 };
    await store.writeProject("first", document, history);
    await store.writeProject("second", document, history);
    assert.deepEqual(await store.readTitleHistories("first"), history);
    const updated = [{ ...history[0]!, titles: [{ title: "old", usedAt: 30 }] }];
    await store.writeProject("first", document, updated);
    assert.deepEqual(await store.readTitleHistories("first"), updated);
    assert.deepEqual(await store.readTitleHistories("second"), history);
    await assert.rejects(store.writeProject("first", { changed: true }, [{
      ...history[0]!, titles: [{ title: "invalid", usedAt: -1 }],
    }]));
    assert.deepEqual(await store.readProject("first"), document);
    assert.deepEqual(await store.readTitleHistories("first"), updated);
    await database.close();
    reopened = new WorkbenchDatabaseController({ databasePath });
    const reopenedStore = new WorkbenchThreadStateStore(reopened);
    assert.deepEqual(await reopenedStore.readTitleHistories("first"), updated);
    await reopenedStore.writeProject("first", document);
    assert.deepEqual(await reopenedStore.readTitleHistories("first"), updated);
    await reopenedStore.writeProject("first", document, []);
    assert.deepEqual(await reopenedStore.readTitleHistories("first"), []);
    assert.deepEqual(await reopenedStore.readTitleHistories("second"), history);
  } finally {
    await reopened?.close();
    await database.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("thread-state documents round trip, replace, stay isolated, and survive reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-thread-state-store-"));
  const databasePath = join(directory, "workbench.sqlite3");
  const database = new WorkbenchDatabaseController({ databasePath });
  let reopened: WorkbenchDatabaseController | null = null;
  try {
    const store = new WorkbenchThreadStateStore(database, () => 10);
    const firstProject = { drafts: [{ draftId: "draft" }], records: [], version: 4 };
    const secondProject = { drafts: [], records: [{ title: "second" }], version: 4 };
    const replacedProject = { drafts: [], records: [{ title: "replaced" }], version: 4 };
    const home = { displayOrder: { attention: { thread: { above: [], below: [] } } }, revision: 2, version: 1 };
    const pinned = { displayOrder: {}, importedProjectIds: ["first"], revision: 3, version: 1 };

    assert.equal(await store.readProject("first"), null);
    assert.equal(await store.readGlobal("homeDisplayOrder"), null);
    await store.writeProject("first", firstProject);
    await store.writeProject("second", secondProject);
    await store.writeProject("first", replacedProject);
    await store.writeGlobal("homeDisplayOrder", home);
    await store.writeGlobal("pinnedLayout", pinned);

    assert.deepEqual(await store.readProject("first"), replacedProject);
    assert.deepEqual(await store.readProject("second"), secondProject);
    assert.deepEqual(await store.readGlobal("homeDisplayOrder"), home);
    assert.deepEqual(await store.readGlobal("pinnedLayout"), pinned);

    await database.close();
    reopened = new WorkbenchDatabaseController({ databasePath });
    const reopenedStore = new WorkbenchThreadStateStore(reopened);
    assert.deepEqual(await reopenedStore.readProject("first"), replacedProject);
    assert.deepEqual(await reopenedStore.readProject("second"), secondProject);
    assert.deepEqual(await reopenedStore.readGlobal("homeDisplayOrder"), home);
    assert.deepEqual(await reopenedStore.readGlobal("pinnedLayout"), pinned);
  } finally {
    await reopened?.close();
    await database.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("thread-state tables reject malformed JSON and unknown global document ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-thread-state-constraints-"));
  const database = new WorkbenchDatabaseController({ databasePath: join(directory, "workbench.sqlite3") });
  try {
    await assert.rejects(
      database.executeTransaction([
        insertRow(threadStateTables.workbenchThreadStateProjects, {
          project_id: "project",
          document_json: "not-json",
          updated_at: 1,
        }),
      ]),
      (error) => error instanceof WorkbenchDatabaseRequestFailure && /CHECK constraint failed/u.test(error.message),
    );
    await assert.rejects(
      database.executeTransaction([{
        kind: "insert",
        tableName: threadStateTables.workbenchThreadStateGlobals.name,
        values: [["id", "unknown"], ["document_json", "{}"], ["updated_at", 1]],
      }]),
      (error) => error instanceof WorkbenchDatabaseRequestFailure && /CHECK constraint failed/u.test(error.message),
    );
  } finally {
    await database.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("authoritative document commits precede shadow dirt notifications", async () => {
  const events: string[] = [];
  const database = {
    executeTransaction: async () => {
      events.push("authority");
      return { changes: 1 };
    },
    query: async () => [],
  };
  const store = new WorkbenchThreadStateStore(database, () => 10, {
    markGlobal: (id) => events.push(`shadow:global:${id}`),
    markProject: (projectId) => events.push(`shadow:project:${projectId}`),
  });

  await store.writeProject("project", {});
  await store.writeGlobal("pinnedLayout", {});
  assert.deepEqual(events, [
    "authority",
    "shadow:project:project",
    "authority",
    "shadow:global:pinnedLayout",
  ]);
});
