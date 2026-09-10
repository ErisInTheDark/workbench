/*
 * No production exports. Protect store pagination and fresh-wrapper durability.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Database from "better-sqlite3";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchThreadIdentityRepository from "./database/thread-identity/WorkbenchThreadIdentityRepository";
import WorkbenchSubagentRelationshipRepository from "./database/thread-state/WorkbenchSubagentRelationshipRepository";
import type { WorkbenchSubagentPersistence } from "./database/thread-state/workbench-thread-state-persistence";

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  const identities = new WorkbenchThreadIdentityRepository(database);
  const observe = (nativeThreadId: string) => identities.observe({
    native: { harness: "codex", nativeLocation: "C:/project", nativeThreadId },
    projectId: "project", projectRoot: "C:/project", title: nativeThreadId,
    createdAt: 1, updatedAt: 1, activityAt: 1,
  }).threadId;
  const repository = new WorkbenchSubagentRelationshipRepository(database);
  const persistence: WorkbenchSubagentPersistence = {
    readSubagents: async (query) => repository.read(query),
    readOwnedSubagents: async (parent, project, threads) => repository.getOwnedMany(parent, project, threads),
    reserveSubagent: async (record) => repository.reserve(record),
    activateSubagent: async (parent, reservation, record) => repository.activate(parent, reservation, record),
    removeSubagent: async (parent, identifier) => { repository.remove(parent, identifier); },
  };
  const metadata = (parentThreadId: string, name: string, createdAt = 1) => ({
    parentThreadId, reservationId: randomUUID(), projectId: "project", harness: "codex" as const,
    cwd: "C:/project", name, title: `Task ${name}`, profileId: "profile", profileName: "reviewer",
    createdAt, updatedAt: createdAt,
  });
  const add = async (store: WorkbenchSubagentStore, parent: string, name: string, createdAt = 1) => {
    const { reservationId, ...reserved } = await store.reserve(metadata(parent, name, createdAt));
    const record = { ...reserved, threadId: observe(name) };
    await store.replace(parent, reservationId, record);
    return record;
  };
  return { database, observe, persistence, metadata, add };
}

test("SQL pages keep parent/project scope and do not repeat entries at equal timestamps", async (context) => {
  const { database, observe, persistence, add } = fixture();
  context.after(() => database.close());
  const store = new WorkbenchSubagentStore(persistence);
  const parent = observe("parent");
  const otherParent = observe("other-parent");
  const children = [];
  for (let index = 0; index < 25; index += 1) {
    children.push(await add(store, parent, `child-${index}`, Math.floor(index / 2)));
  }
  const other = await add(store, otherParent, "other-child");
  const first = await store.list({ parentThreadId: parent, projectId: "project" });
  assert.equal(first.subagents.length, 20);
  assert.ok(first.nextCursor);
  const second = await store.list({ parentThreadId: parent, projectId: "project", cursor: first.nextCursor });
  assert.equal(second.subagents.length, 5);
  assert.equal(second.nextCursor, null);
  const combined = [...first.subagents, ...second.subagents];
  assert.deepEqual(new Set(combined.map(record => record.threadId)), new Set(children.map(record => record.threadId)));
  assert.ok(combined.every((record, index) => index === 0 || combined[index - 1]!.createdAt >= record.createdAt));
  assert.equal((await store.list({ projectId: "project" })).subagents.length, 26);
  assert.deepEqual((await store.list({ parentThreadId: otherParent, projectId: "project" })).subagents, [other]);
  await assert.rejects(store.list({ parentThreadId: otherParent, projectId: "project", cursor: first.nextCursor }));
  await assert.rejects(store.list({ parentThreadId: parent, projectId: "another", cursor: first.nextCursor }));
  await assert.rejects(store.list({ parentThreadId: parent, projectId: "project", cursor: "not-json" }));
  await assert.rejects(store.list({ parentThreadId: parent, projectId: "project", limit: 21 }));
  await assert.rejects(store.list({ projectId: "project", cursor: first.nextCursor }));
});

test("fresh store wrappers share durable reservations and never reuse allocated indexes", async (context) => {
  const { database, observe, persistence, metadata, add } = fixture();
  context.after(() => database.close());
  const parent = observe("parent");
  const first = new WorkbenchSubagentStore(persistence);
  const second = new WorkbenchSubagentStore(persistence);
  const reserved = await first.reserve(metadata(parent, "held"));
  assert.deepEqual((await second.list({ projectId: "project" })).subagents, []);
  await assert.rejects(second.reserve(metadata(parent, "HELD")));
  await second.remove(parent, reserved.reservationId);
  const children = await Promise.all([add(first, parent, "one"), add(second, parent, "two")]);
  assert.deepEqual(children.map(record => record.directSubagentIndex), [1, 2]);
  const reopened = new WorkbenchSubagentStore(persistence);
  assert.deepEqual(new Set((await reopened.list({ projectId: "project" })).subagents.map(record => record.threadId)),
    new Set(children.map(record => record.threadId)));
  assert.deepEqual(database.pragma("foreign_key_check"), []);
});

test("ownership admission is all-or-nothing and wrong parents cannot remove membership", async (context) => {
  const { database, observe, persistence, add } = fixture();
  context.after(() => database.close());
  const store = new WorkbenchSubagentStore(persistence);
  const parent = observe("parent");
  const otherParent = observe("other-parent");
  const child = await add(store, parent, "child");
  const other = await add(store, otherParent, "other");
  assert.deepEqual(await store.getOwned(parent, "project", child.threadId), child);
  assert.equal(await store.getOwned(parent, "another", child.threadId), null);
  assert.equal(await store.getOwned(otherParent, "project", child.threadId), null);
  assert.equal(await store.getOwnedMany(parent, "project", [child.threadId, other.threadId]), null);
  await store.remove(otherParent, child.threadId);
  assert.deepEqual(await store.getOwnedMany(parent, "project", [child.threadId]), [child]);
  await store.remove(parent, child.threadId);
  assert.equal(await store.getOwned(parent, "project", child.threadId), null);
  assert.ok(database.prepare("SELECT id FROM workbench_threads WHERE id = ?").get(child.threadId));
});
