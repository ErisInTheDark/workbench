/*
 * Exports:
 * - No production exports; Node tests cover per-parent migration, relationship-only durability, cross-generation writes, bounded cursor pages, and parent isolation. Keywords: subagent, store, migration, relationship, reload, pagination, test.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";
import type { WorkbenchSubagentParentSnapshot } from "./database/thread-state/workbench-thread-state-shadow-types";
import { createWorkbenchSubagentStoreState } from "./workbench-subagent-store-state";

function summary(
  parentThreadId: string,
  threadId: string,
  overrides: Partial<WorkbenchSubagentRelationship> = {},
): WorkbenchSubagentRelationship {
  return {
    createdAt: 1,
    cwd: "C:/workspace",
    directSubagentIndex: 0,
    harness: "codex",
    name: `Agent ${threadId}`,
    parentThreadId,
    profileId: "profile",
    profileName: "Lily INFINITE",
    projectId: "project",
    threadId,
    title: `Task ${threadId}`,
    updatedAt: 1,
    ...overrides,
  };
}

async function addActive(store: WorkbenchSubagentStore, source: WorkbenchSubagentRelationship) {
  const { threadId, directSubagentIndex: _index, ...metadata } = source;
  const { reservationId, ...reserved } = await store.reserve({ ...metadata, reservationId: randomUUID() });
  const record = { ...reserved, threadId };
  await store.replace(source.parentThreadId, reservationId, record);
  return record;
}

test("legacy reservations become typed UUID reservations without becoming child threads", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-reservation-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const directory = path.join(root, ".workbench", "runtime", "subagents");
  await fs.mkdir(directory, { recursive: true });
  const reservationId = randomUUID();
  const source = summary("parent", `pending:${reservationId}`, { name: "Reserved", directSubagentIndex: 3 });
  await fs.writeFile(path.join(directory, `${encodeTranscriptPathSegment("parent")}.json`), JSON.stringify({
    parentThreadId: "parent", schemaVersion: 4, nextDirectSubagentIndex: 4,
    subagents: { [source.threadId]: source },
  }));
  const state = createWorkbenchSubagentStoreState();
  const store = new WorkbenchSubagentStore(root, { state });
  await store.initialize();
  const reserved = [...state.parents.get("parent")!.values()][0]!;
  assert.equal(Reflect.get(reserved, "kind"), "reserved");
  assert.equal(Reflect.get(reserved, "reservationId"), reservationId);
  assert.equal("threadId" in reserved, false);
  assert.deepEqual((await store.list({ projectId: "project" })).subagents, []);
  const { threadId: _threadId, directSubagentIndex: _index, ...metadata } = source;
  await assert.rejects(store.reserve({ ...metadata, reservationId: randomUUID() }), /name is already in use/u);
  await store.replace("parent", reservationId, { ...source, threadId: "child" });
  assert.equal(state.parents.get("parent")!.size, 1);
  const reopened = new WorkbenchSubagentStore(root, { state: createWorkbenchSubagentStoreState() });
  const active = (await reopened.list({ projectId: "project" })).subagents;
  assert.equal(active[0]?.threadId, "child");
  assert.equal(active[0]?.directSubagentIndex, 3);
  await reopened.remove("parent", "child");
  const next = await reopened.reserve({ ...metadata, reservationId: randomUUID() });
  assert.equal(next.directSubagentIndex, 4);
  assert.deepEqual((await reopened.list({ projectId: "project" })).subagents, []);
});

test("migrates the global store into parent files and removes legacy lifecycle fields", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-migration-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const runtimePath = path.join(root, ".workbench", "runtime");
  await fs.mkdir(runtimePath, { recursive: true });
  const legacyActive = { ...summary("parent-a", "child-a", { updatedAt: 10 }), activityStatus: "active", lastActivityAt: 10, pinned: true };
  const legacyUnknown = summary("parent-b", "child-b", { updatedAt: 20 });
  await fs.writeFile(path.join(runtimePath, "subagents.json"), JSON.stringify({
    subagents: {
      [legacyActive.threadId]: legacyActive,
      [legacyUnknown.threadId]: legacyUnknown,
    },
    version: 1,
  }), "utf8");

  const store = new WorkbenchSubagentStore(root);
  await store.initialize();
  await assert.rejects(fs.access(path.join(runtimePath, "subagents.json")));
  const parentFiles = await fs.readdir(path.join(runtimePath, "subagents"));
  assert.equal(parentFiles.length, 2);
  const migrated = (await store.list({ parentThreadId: "parent-a", projectId: "project" })).subagents[0];
  assert.equal("activityStatus" in (migrated ?? {}), false);
  assert.equal("lastActivityAt" in (migrated ?? {}), false);
  assert.equal("pinned" in (migrated ?? {}), false);
  const restarted = new WorkbenchSubagentStore(root, { state: createWorkbenchSubagentStoreState() });
  await restarted.initialize();
  assert.equal((await restarted.list({ parentThreadId: "parent-a", projectId: "project" })).subagents[0]?.threadId, "child-a");
});

test("repeats a partial migration without replacing a newer parent record", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-partial-migration-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const runtimePath = path.join(root, ".workbench", "runtime");
  const parentPath = path.join(runtimePath, "subagents");
  await fs.mkdir(parentPath, { recursive: true });
  const older = summary("parent", "child", { title: "Older legacy record", updatedAt: 10 });
  const newer = summary("parent", "child", { title: "Newer parent record", updatedAt: 20 });
  await fs.writeFile(path.join(parentPath, `${encodeTranscriptPathSegment("parent")}.json`), JSON.stringify({
    parentThreadId: "parent",
    schemaVersion: 2,
    subagents: { child: newer },
  }), "utf8");
  await fs.writeFile(path.join(runtimePath, "subagents.json"), JSON.stringify({
    subagents: { child: older },
    version: 1,
  }), "utf8");

  const store = new WorkbenchSubagentStore(root);
  await store.initialize();
  const [record] = (await store.list({ parentThreadId: "parent", projectId: "project" })).subagents;
  assert.equal(record?.title, "Newer parent record");
  await assert.rejects(fs.access(path.join(runtimePath, "subagents.json")));
  const restarted = new WorkbenchSubagentStore(root, { state: createWorkbenchSubagentStoreState() });
  assert.equal((await restarted.list({ parentThreadId: "parent", projectId: "project" })).subagents[0]?.title, "Newer parent record");
});

test("keeps parent writes isolated, lists project relationships, and pages newest relationships twenty at a time", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-pages-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const store = new WorkbenchSubagentStore(root);
  await store.initialize();
  for (let index = 0; index < 25; index += 1) {
    await addActive(store, summary("parent-a", `child-${index.toString().padStart(2, "0")}`, {
      createdAt: index,
      updatedAt: index,
    }));
  }
  await addActive(store, summary("parent-b", "other-child"));

  const projectRelationships = await store.list({ projectId: "project" });
  assert.equal(projectRelationships.subagents.find(({ threadId }) => threadId === "other-child")?.parentThreadId, "parent-b");

  const first = await store.list({ limit: 20, parentThreadId: "parent-a", projectId: "project" });
  assert.equal(first.subagents.length, 20);
  assert.equal(first.subagents[0]?.threadId, "child-24");
  assert.ok(first.nextCursor);
  const second = await store.list({ cursor: first.nextCursor, limit: 20, parentThreadId: "parent-a", projectId: "project" });
  assert.equal(second.subagents.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.subagents, ...second.subagents].map(({ threadId }) => threadId)).size, 25);
  await assert.rejects(
    store.list({ cursor: first.nextCursor, parentThreadId: "parent-b", projectId: "project" }),
    /Invalid subagent list cursor/u,
  );
  await assert.rejects(store.list({ limit: 21, parentThreadId: "parent-a", projectId: "project" }), /between 1 and 20/u);

  const files = await fs.readdir(path.join(root, ".workbench", "runtime", "subagents"));
  assert.equal(files.length, 2);
  assert.deepEqual((await store.list({ parentThreadId: "parent-b", projectId: "project" })).subagents.map(({ threadId }) => threadId), ["other-child"]);
});

test("relationship updates do not acquire lifecycle or Lock fields", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-relationship-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const store = new WorkbenchSubagentStore(root);
  const reserved = await addActive(store, summary("parent", "child"));
  await store.replace("parent", "child", { ...reserved, title: "Updated", updatedAt: 200 });
  const [record] = (await store.list({ parentThreadId: "parent", projectId: "project" })).subagents;
  assert.equal(record?.title, "Updated");
  assert.equal("lifecycle" in (record ?? {}), false);
  assert.equal("pinned" in (record ?? {}), false);
});

test("fresh wrappers serialize one parent and persist unique direct-child indexes", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-reload-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const state = createWorkbenchSubagentStoreState();
  const first = new WorkbenchSubagentStore(root, { state });
  const second = new WorkbenchSubagentStore(root, { state });

  await Promise.all([
    addActive(first, summary("parent", "child-a", { name: "A" })),
    addActive(second, summary("parent", "child-b", { name: "B" })),
  ]);

  const memoryRecords = (await first.list({ parentThreadId: "parent", projectId: "project" })).subagents;
  assert.deepEqual(memoryRecords.map(({ directSubagentIndex }) => directSubagentIndex).sort((left, right) => left - right), [0, 1]);
  const restarted = new WorkbenchSubagentStore(root, { state: createWorkbenchSubagentStoreState() });
  const diskRecords = (await restarted.list({ parentThreadId: "parent", projectId: "project" })).subagents;
  assert.deepEqual(new Set(diskRecords.map(({ threadId }) => threadId)), new Set(["child-a", "child-b"]));
  assert.deepEqual(diskRecords.map(({ directSubagentIndex }) => directSubagentIndex).sort((left, right) => left - right), [0, 1]);
});

test("a fresh wrapper publishes relationships already loaded by shared state", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-republish-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const state = createWorkbenchSubagentStoreState();
  const firstSnapshots: WorkbenchSubagentParentSnapshot[][] = [];
  const secondSnapshots: WorkbenchSubagentParentSnapshot[][] = [];
  const first = new WorkbenchSubagentStore(root, {
    shadow: { replaceSubagentParents: (parents) => firstSnapshots.push([...parents]) },
    state,
  });
  await addActive(first, summary("parent", "child"));
  const second = new WorkbenchSubagentStore(root, {
    shadow: { replaceSubagentParents: (parents) => secondSnapshots.push([...parents]) },
    state,
  });
  await second.initialize();
  assert.equal(firstSnapshots.at(-1)?.length, 1);
  assert.equal(secondSnapshots.length, 1);
  const published = secondSnapshots[0]?.[0]?.relationships[0];
  assert.equal(published?.kind === "active" ? published.threadId : null, "child");
});

test("shadow snapshots split mixed parent scopes and preserve the saved allocation watermark", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-scopes-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const snapshots: WorkbenchSubagentParentSnapshot[][] = [];
  const store = new WorkbenchSubagentStore(root, {
    shadow: { replaceSubagentParents: (parents) => snapshots.push([...parents]) },
    state: createWorkbenchSubagentStoreState(),
  });
  await addActive(store, summary("shared-parent", "child-a", { name: "A", projectId: "project-a" }));
  await addActive(store, summary("shared-parent", "child-b", { harness: "copilot", name: "B", projectId: "project-b" }));

  assert.deepEqual(snapshots.at(-1)?.map((parent) => ({
    harness: parent.harness,
    nextDirectSubagentIndex: parent.nextDirectSubagentIndex,
    projectId: parent.projectId,
    threadIds: parent.relationships.flatMap((relationship) => relationship.kind === "active" ? [relationship.threadId] : []),
  })), [
    { harness: "codex", nextDirectSubagentIndex: 2, projectId: "project-a", threadIds: ["child-a"] },
    { harness: "copilot", nextDirectSubagentIndex: 2, projectId: "project-b", threadIds: ["child-b"] },
  ]);
});

test("successful relationship writes publish complete shadow snapshots", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-subagent-store-shadow-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const snapshots: WorkbenchSubagentParentSnapshot[][] = [];
  const store = new WorkbenchSubagentStore(root, {
    shadow: {
      replaceSubagentParents: (parents) => snapshots.push([...parents]),
    },
    state: createWorkbenchSubagentStoreState(),
  });

  await store.initialize();
  const { threadId: _threadId, directSubagentIndex: _index, ...metadata } = summary("parent", "child");
  const reservationId = randomUUID();
  const { reservationId: _reservationId, ...reserved } = await store.reserve({ ...metadata, reservationId });
  await store.replace("parent", reservationId, { ...reserved, threadId: "child", updatedAt: 2 });
  await store.remove("parent", "child");

  assert.deepEqual(snapshots.map((snapshot) => snapshot.flatMap(({ relationships }) => relationships.map((relationship) => (
    relationship.kind === "reserved" ? relationship.reservationId : relationship.threadId
  )))), [
    [],
    [reservationId],
    ["child"],
    [],
  ]);
});
