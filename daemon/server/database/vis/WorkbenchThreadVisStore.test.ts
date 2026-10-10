/* No production exports. Protect one live vis session per file, start and end snapshots, resumable active sessions and retention deletes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadVisStore from "./WorkbenchThreadVisStore";

async function fixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("vis-store-");
  const database = new Database(path.join(temporary.path, "state.sqlite"));
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  context.after(async () => { database.close(); await temporary.dispose(); });
  const identities = new WorkbenchThreadIdentityRepository(database);
  const [threadId, otherThreadId] = ["one", "two"].map(native => identities.observe({
    native: { harness: "claude", nativeLocation: temporary.path, nativeThreadId: NativeThreadIdSchema.parse(native) },
    projectId: testProjectIds.fixture, projectRoot: temporary.path,
    title: native, createdAt: 1, updatedAt: 1, activityAt: 1,
  }).threadId);
  const store = new WorkbenchThreadVisStore(database);
  const start = (thread: string, file: string, at = 1) => store.execute({
    kind: "start",
    session: { sessionId: randomUUID(), threadId: thread, harness: "claude", cwd: temporary.path, projectId: testProjectIds.fixture, path: file, startedAt: at },
    snapshot: { capturedAt: at, document: `<p>${file} start</p>`, failure: null },
  }).sessions[0]!;
  return { store, start, threadId: threadId!, otherThreadId: otherThreadId! };
}

test("a file holds one live session per thread until it ends, and both moments keep their documents", async context => {
  const { store, start, threadId, otherThreadId } = await fixture(context);
  const first = start(threadId, "a.html");
  start(otherThreadId, "a.html");
  assert.throws(() => start(threadId, "a.html"), /already live/u);
  const ended = store.execute({ kind: "end", threadId, path: "a.html", endedBy: "user", snapshot: { capturedAt: 5, document: null, failure: "gone" } });
  assert.equal(ended.sessions[0]?.endedAt, 5);
  assert.deepEqual(store.execute({ kind: "end", threadId, path: "a.html", endedBy: "agent", snapshot: { capturedAt: 6, document: "", failure: null } }).sessions, []);
  assert.deepEqual(store.execute({ kind: "readUserEnded", threadId }).userEnded, [{ sessionId: first.sessionId, path: "a.html", endedAt: 5 }]);
  assert.deepEqual(store.execute({ kind: "readUserEnded", threadId: otherThreadId }).userEnded, [], "agent ends and other threads never show as user ends");
  const restarted = start(threadId, "a.html", 7);
  assert.notEqual(restarted.sessionId, first.sessionId);
  assert.equal(store.execute({ kind: "readSnapshot", sessionId: first.sessionId, snapshotKind: "start" }).snapshot?.document, "<p>a.html start</p>");
  assert.deepEqual(store.execute({ kind: "readSnapshot", sessionId: first.sessionId, snapshotKind: "end" }).snapshot,
    { sessionId: first.sessionId, kind: "end", path: "a.html", capturedAt: 5, document: null, failure: "gone" });
  assert.deepEqual(store.execute({ kind: "readActive" }).sessions.map(({ threadId: owner, path: file }) => `${owner === threadId ? "one" : "two"}:${file}`),
    ["two:a.html", "one:a.html"]);
});

test("retention deletes a thread's sessions with their snapshots and leaves other threads", async context => {
  const { store, start, threadId, otherThreadId } = await fixture(context);
  const mine = start(threadId, "a.svg");
  start(otherThreadId, "b.svg");
  store.execute({ kind: "delete", threadIds: [threadId] });
  assert.equal(store.execute({ kind: "readSnapshot", sessionId: mine.sessionId, snapshotKind: "start" }).snapshot, null);
  assert.deepEqual(store.execute({ kind: "readActive" }).sessions.map(({ path: file }) => file), ["b.svg"]);
});
