/*
 * No production exports. Tests protect shared-worker thread-state document round trips, replacement, isolation, reopen durability, transcript-reset survival, JSON constraints, and shadow queue lifecycle. Keywords: thread state, sqlite, shadow, queue, lifecycle, test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import WorkbenchDatabaseController, { WorkbenchDatabaseRequestFailure } from "./database/WorkbenchDatabaseController";
import { threadStateTables } from "./database/workbench-database-schema";
import WorkbenchThreadStateStore, { type WorkbenchThreadStateStoreDatabase } from "./WorkbenchThreadStateStore";
import { insertRow } from "workbench-shared/database/workbench-database-statements";

test("thread-state documents round trip, replace, stay isolated, survive reopen, and outlive transcript reset", async () => {
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

    const issues: string[] = [];
    store.baselineProject("first", replacedProject, (candidate) => candidate as object, (issue) => issues.push(issue));
    await store.waitForIdle();
    assert.deepEqual(issues, []);
    store.baselineProject("first", firstProject, (candidate) => candidate as object, (issue) => issues.push(issue));
    await store.waitForIdle();
    assert.equal(issues.length, 1);
    assert.match(issues[0] ?? "", /mismatched: paths=root\./u);
    store.writeAndVerifyProject("first", replacedProject, (candidate) => candidate as object, (issue) => issues.push(issue));
    await store.waitForIdle();
    assert.equal(issues.length, 1);
    assert.deepEqual(await store.readProject("first"), replacedProject);
    assert.deepEqual(await store.readProject("second"), secondProject);
    assert.deepEqual(await store.readGlobal("homeDisplayOrder"), home);
    assert.deepEqual(await store.readGlobal("pinnedLayout"), pinned);

    await database.resetTranscript();
    assert.deepEqual(await store.readProject("first"), replacedProject);
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

test("shadow scheduling is non-blocking, ordered, failure-tolerant, and lifecycle-drained", async () => {
  const calls: string[] = [];
  const issues: string[] = [];
  let queryCount = 0;
  let releaseFirstQuery: (() => void) | null = null;
  const firstQuery = new Promise<void>((resolve) => { releaseFirstQuery = resolve; });
  const database: WorkbenchThreadStateStoreDatabase = {
    executeTransaction: async () => {
      calls.push("write");
      return { changes: 1 };
    },
    query: async () => {
      queryCount += 1;
      calls.push(`query:${queryCount}`);
      if (queryCount === 1) await firstQuery;
      if (queryCount === 2) throw new Error("simulated shadow failure");
      return [];
    },
  };
  const store = new WorkbenchThreadStateStore(database);
  const report = (issue: string) => issues.push(issue);

  store.baselineProject("project", { version: 4 }, (candidate) => candidate as object, report);
  store.baselineGlobal("homeDisplayOrder", { version: 1 }, (candidate) => candidate as object, report);
  store.baselineGlobal("pinnedLayout", { version: 1 }, (candidate) => candidate as object, report);

  let drained = false;
  const draining = store.waitForIdle().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.deepEqual(calls, ["query:1"]);

  releaseFirstQuery?.();
  await draining;
  assert.equal(drained, true);
  assert.deepEqual(calls, ["query:1", "write", "query:2", "query:3", "write"]);
  assert.equal(issues.length, 1);
  assert.match(issues[0] ?? "", /SQLite home thread display order baseline failed: simulated shadow failure/u);
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
