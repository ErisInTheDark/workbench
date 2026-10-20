/* No production exports. Protect one live vis session per file, start and end snapshots, stored build contexts, bounded per-file control state that outlives sessions, resumable active sessions and retention deletes. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { VIS_MAX_CONTROLS } from "workbench-shared/workbench/vis/vis-contract";
import { installWorkbenchDatabaseSchema } from "../workbench-database-schema";
import WorkbenchThreadIdentityRepository from "../thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchThreadVisStore, { type ThreadVisStoredBuild } from "./WorkbenchThreadVisStore";

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
  const start = (thread: string, file: string, at = 1, build: ThreadVisStoredBuild = { kind: "caller" }) => store.execute({
    kind: "start",
    session: {
      sessionId: randomUUID(), threadId: thread, harness: "claude", cwd: temporary.path, projectId: testProjectIds.fixture,
      path: file, build, startedAt: at,
    },
    snapshot: { capturedAt: at, document: `<p>${file} start</p>`, failure: null },
  }).sessions[0]!;
  return { database, store, start, threadId: threadId!, otherThreadId: otherThreadId! };
}

test("a file holds one live session per thread until it ends, and both moments keep their documents", async context => {
  const { store, start, threadId, otherThreadId } = await fixture(context);
  const first = start(threadId, "a.html");
  start(otherThreadId, "a.html");
  assert.throws(() => start(threadId, "a.html"), /already live/u);
  const ended = store.execute({ kind: "end", threadId, path: "a.html", endedBy: "user", snapshot: { capturedAt: 5, document: null, failure: "gone" } });
  assert.equal(ended.sessions[0]?.endedAt, 5);
  assert.deepEqual(store.execute({ kind: "end", threadId, path: "a.html", endedBy: "agent", snapshot: { capturedAt: 6, document: "", failure: null } }).sessions, []);
  const restarted = start(threadId, "a.html", 7);
  assert.notEqual(restarted.sessionId, first.sessionId);
  assert.equal(store.execute({ kind: "readSnapshot", sessionId: first.sessionId, snapshotKind: "start" }).snapshot?.document, "<p>a.html start</p>");
  assert.deepEqual(store.execute({ kind: "readSnapshot", sessionId: first.sessionId, snapshotKind: "end" }).snapshot,
    { sessionId: first.sessionId, kind: "end", path: "a.html", capturedAt: 5, document: null, failure: "gone" });
  assert.deepEqual(store.execute({ kind: "readActive" }).sessions.map(({ threadId: owner, path: file }) => `${owner === threadId ? "one" : "two"}:${file}`),
    ["two:a.html", "one:a.html"]);
});

test("retention deletes a thread's sessions with their snapshots and control state, and leaves other threads", async context => {
  const { store, start, threadId, otherThreadId } = await fixture(context);
  const mine = start(threadId, "a.svg");
  start(otherThreadId, "b.svg");
  store.execute({ kind: "setControl", threadId, sessionId: mine.sessionId, controlId: "tab", value: "1", updatedAt: 2 });
  store.execute({ kind: "delete", threadIds: [threadId] });
  assert.equal(store.execute({ kind: "readSnapshot", sessionId: mine.sessionId, snapshotKind: "start" }).snapshot, null);
  assert.deepEqual(store.execute({ kind: "readControls", threadId, path: "a.svg" }).controls, {});
  assert.deepEqual(store.execute({ kind: "readActive" }).sessions.map(({ path: file }) => file), ["b.svg"]);
});

test("build contexts survive storage, so resumed sessions build where they started", async context => {
  const { store, start, threadId } = await fixture(context);
  start(threadId, "a.tsx", 1, { kind: "kit" });
  start(threadId, "b.tsx", 2, { kind: "folder", root: "/elsewhere" });
  start(threadId, "c.tsx", 3);
  assert.deepEqual(store.execute({ kind: "readActive" }).sessions.map(({ build }) => build),
    [{ kind: "kit" }, { kind: "folder", root: "/elsewhere" }, { kind: "caller" }]);
});

test("control state belongs to a thread's file, set only through its live session, and outlives the session", async context => {
  const { store, start, threadId, otherThreadId } = await fixture(context);
  const first = start(threadId, "a.html");
  const set = (thread: string, sessionId: string, controlId: string, value: string, at = 2) =>
    store.execute({ kind: "setControl", threadId: thread, sessionId, controlId, value, updatedAt: at }).sessions;
  assert.deepEqual(set(otherThreadId, first.sessionId, "tab", "\"x\""), [], "another thread cannot set this file's controls");
  set(threadId, first.sessionId, "tab", "\"card\"");
  set(threadId, first.sessionId, "tab", "\"step\"", 3);
  set(threadId, first.sessionId, "open", "true", 4);
  const read = (file = "a.html") => store.execute({ kind: "readControls", threadId, path: file }).controls;
  assert.deepEqual(read(), { open: "true", tab: "\"step\"" });
  assert.deepEqual(read("b.html"), {});

  store.execute({ kind: "end", threadId, path: "a.html", endedBy: "agent", snapshot: { capturedAt: 5, document: null, failure: null } });
  assert.deepEqual(set(threadId, first.sessionId, "tab", "\"late\""), [], "an ended session takes no more changes");
  start(threadId, "a.html", 7);
  assert.deepEqual(read(), { open: "true", tab: "\"step\"" }, "a restarted file starts from the state the user left");
});

test("a file keeps its most recently changed controls", async context => {
  const { database, store, start, threadId } = await fixture(context);
  const { sessionId } = start(threadId, "a.html");
  // One outer transaction keeps hundreds of changes from syncing to disk one by one.
  database.transaction(() => {
    for (let index = 0; index <= VIS_MAX_CONTROLS; index++) {
      store.execute({ kind: "setControl", threadId, sessionId, controlId: `c${index}`, value: `${index}`, updatedAt: index });
    }
  })();
  const controls = store.execute({ kind: "readControls", threadId, path: "a.html" }).controls ?? {};
  assert.equal(Object.keys(controls).length, VIS_MAX_CONTROLS);
  assert.equal(controls.c0, undefined, "the oldest change goes first");
  assert.equal(controls[`c${VIS_MAX_CONTROLS}`], `${VIS_MAX_CONTROLS}`);
});
