/*
 * No production exports. Tests protect inbound grant durability: a repeated approval reuses its grant, callers never see each
 * other's grants, revoking one need leaves the rest, and a settled target takes exactly the grants naming it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { DaemonIdSchema, ProjectIdSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { NetworkGrantCreate } from "workbench-shared/workbench/network/network-grants";
import { installWorkbenchDatabaseSchema } from "../database/workbench-database-schema";
import WorkbenchNetworkGrantStore from "./WorkbenchNetworkGrantStore";

const remote = DaemonIdSchema.parse("22222222-2222-4222-8222-222222222222");
const create = (overrides: Partial<NetworkGrantCreate> = {}): NetworkGrantCreate => ({
  kind: "thread", callerDaemonId: remote, callerThreadId: WorkbenchThreadIdSchema.parse("caller"), callerHostname: "tower",
  callerTitle: "caller", targetThreadId: WorkbenchThreadIdSchema.parse("target"), targetProjectId: null, targetLabel: "target",
  ...overrides,
});

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  installWorkbenchDatabaseSchema(database);
  return { database, store: new WorkbenchNetworkGrantStore(database) };
}

test("approving the same target twice keeps one grant", (context) => {
  const { database, store } = fixture();
  context.after(() => database.close());
  const first = store.create({ id: "33333333-3333-4333-8333-333333333333", createdAt: 1, grant: create() });
  const again = store.create({ id: "44444444-4444-4444-8444-444444444444", createdAt: 2, grant: create() });
  assert.equal(again.id, first.id);
  assert.equal(store.forCaller(remote, "caller").length, 1);
});

test("a settled target takes every grant naming it, from every caller, and nothing else", (context) => {
  const { database, store } = fixture();
  context.after(() => database.close());
  store.create({ id: "33333333-3333-4333-8333-333333333333", createdAt: 1, grant: create() });
  store.create({ id: "44444444-4444-4444-8444-444444444444", createdAt: 1, grant: create({ kind: "message", callerThreadId: WorkbenchThreadIdSchema.parse("other") }) });
  store.create({ id: "55555555-5555-4555-8555-555555555555", createdAt: 1, grant: create({ targetThreadId: WorkbenchThreadIdSchema.parse("elsewhere") }) });
  store.create({ id: "66666666-6666-4666-8666-666666666666", createdAt: 1,
    grant: create({ kind: "folder", targetThreadId: null, targetProjectId: ProjectIdSchema.parse("folder") }) });

  assert.equal(store.revokeTargeting("target"), 2);
  assert.deepEqual(store.forCaller(remote, "caller").map(grant => grant.targetThreadId ?? grant.targetProjectId).sort(), ["elsewhere", "folder"]);
  assert.equal(store.forCaller(remote, "other").length, 0);
});

test("each caller reads only its own grants, and revoking a reply leaves the full grant", (context) => {
  const { database, store } = fixture();
  context.after(() => database.close());
  store.create({ id: "33333333-3333-4333-8333-333333333333", createdAt: 1, grant: create() });
  store.create({ id: "44444444-4444-4444-8444-444444444444", createdAt: 1, grant: create({ kind: "message" }) });
  store.create({ id: "55555555-5555-4555-8555-555555555555", createdAt: 1,
    grant: create({ kind: "folder", targetThreadId: null, targetProjectId: ProjectIdSchema.parse("folder") }) });
  store.create({ id: "66666666-6666-4666-8666-666666666666", createdAt: 1, grant: create({ callerThreadId: WorkbenchThreadIdSchema.parse("other") }) });
  assert.equal(store.forCaller(remote, "caller").length, 3);

  assert.equal(store.revoke({ callerDaemonId: remote, callerThreadId: WorkbenchThreadIdSchema.parse("caller"),
    need: { kind: "message", threadId: WorkbenchThreadIdSchema.parse("target") } }), 1);
  assert.deepEqual(store.forCaller(remote, "caller").map(grant => grant.kind).sort(), ["folder", "thread"]);

  assert.equal(store.revoke({ callerDaemonId: remote, callerThreadId: WorkbenchThreadIdSchema.parse("caller") }), 2);
  assert.equal(store.forCaller(remote, "other").length, 1);
});
