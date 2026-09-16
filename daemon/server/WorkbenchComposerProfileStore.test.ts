/*
 * Exports:
 * - No production exports; tests cover durable composer-profile mutation semantics.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { WorkbenchComposerProfile } from "workbench-shared/types";
import WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import { projectTables } from "./database/workbench-database-schema";
import { insertRow, selectRows } from "workbench-shared/database/workbench-database-statements";

test("project profile mutations preserve canonical scope through retained aliases", async context => {
  const { create, database } = await fixture(context);
  const projectId = "remote://example.test/profiles";
  await database.executeTransaction([
    insertRow(projectTables.projects, { id: projectId }),
    insertRow(projectTables.aliases, { alias: "old-profiles", project_id: projectId }),
  ]);
  const imported = { ...profile("imported", 1), scope: { kind: "project" as const, projectId: "old-profiles" } };
  const store = create();
  await store.mutate({ kind: "upsert", profile: imported });
  assert.deepEqual((await store.read()).profiles[0]?.scope, { kind: "project", projectId });
  await store.mutate({ kind: "upsert", profile: { ...imported, name: "edited" } }, async value => {
    assert.deepEqual(value.scope, { kind: "project", projectId });
  });
  const independent = "local://C:/profile-only";
  await store.mutate({ kind: "upsert", profile: { ...profile("independent", 1), scope: { kind: "project", projectId: independent } } });
  assert.equal((await database.query(selectRows(projectTables.projects, { where: { id: independent } }))).length, 1);
  assert.deepEqual((await create().read()).profiles.find(value => value.id === "imported")?.scope, { kind: "project", projectId });
});

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-profile-store-"));
  const database = new WorkbenchDatabaseController({ databasePath: path.join(root, "workbench.sqlite3") });
  const stores: WorkbenchComposerProfileStore[] = [];
  context.after(async () => {
    for (const store of stores) await store.dispose();
    await database.close();
    await rm(root, { force: true, recursive: true });
  });
  const create = () => {
    const store = new WorkbenchComposerProfileStore(database);
    stores.push(store);
    return store;
  };
  return { create, database, root };
}

function profile(id: string, updatedAt: number): WorkbenchComposerProfile {
  return {
    agentPath: null,
    agentSource: null,
    createdAt: 1,
    harness: "codex",
    id,
    model: "gpt-5.4",
    name: `Profile ${id}`,
    reasoningEffort: "high",
    scope: { kind: "global" },
    serviceTier: null,
    updatedAt,
  };
}

test("turn usage survives stale edits and reopening without resurrecting deleted profiles", async (context) => {
  const { create } = await fixture(context);
  const store = create();
  const original = profile("used", 2);
  await store.mutate({ kind: "upsert", profile: original });
  await store.recordUsage(original.id, 500);
  await store.recordUsage(original.id, 200);
  await store.mutate({ kind: "upsert", profile: { ...original, name: "Edited" } });
  const saved = (await create().read()).profiles[0];
  assert.equal(saved?.lastUsedAt, 500);
  assert.equal(saved?.name, "Edited");
  assert.equal(saved?.updatedAt, original.updatedAt);
  await store.mutate({ kind: "delete", profileId: original.id });
  await store.recordUsage(original.id, 600);
  assert.deepEqual((await create().read()).profiles, []);
});

test("retired profile reads reject results from their old owner", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-profile-retired-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  const store = new WorkbenchComposerProfileStore({
    query: async () => { enter(); await pending; return []; },
    executeTransaction: async () => { writes += 1; return { changes: 0 }; },
  });
  const starting = store.start().then(() => null, (error: Error) => error);
  await entered;
  const disposing = store.dispose();
  release();
  const [failure] = await Promise.all([starting, disposing]);
  assert.equal(writes, 0);
  assert.match(failure?.message ?? "", /closed/u);
});

test("persists acknowledged profile mutations across store restarts", async (context) => {
  const { create } = await fixture(context);
  const store = create();

  await store.mutate({ kind: "upsert", profile: profile("alpha", 2) });
  await store.mutate({ kind: "upsert", profile: profile("beta", 1) });
  await store.mutate({ kind: "upsert", profile: profile("beta", 4) });
  await store.mutate({ kind: "delete", profileId: "alpha" });
  await store.dispose();
  assert.deepEqual((await create().read()).profiles, [profile("beta", 4)]);
});

test("standalone future-provider profiles survive repeated saves and reopening", async context => {
  const { create } = await fixture(context);
  const store = create();
  const saved = { ...profile("future", 2), harness: "future-provider" };
  await store.mutate({ kind: "upsert", profile: saved });
  await store.mutate({ kind: "upsert", profile: saved });
  await store.dispose();
  assert.deepEqual((await create().read()).profiles, [saved]);
});

test("rejects malformed profile mutations", async (context) => {
  const { create } = await fixture(context);
  await assert.rejects(
    create().mutate({ kind: "upsert", profile: { id: "broken" } }),
    /valid composer profile mutation/u,
  );
});

test("context changes survive reopening without overwriting another profile field", async (context) => {
  const { create } = await fixture(context);
  const store = create();
  const original = { ...profile("context", 1), contextWindowTokens: 500_000 };
  await store.mutate({ kind: "upsert", profile: original });
  assert.equal((await create().read()).profiles[0]?.contextWindowTokens, 500_000);
  await store.mutate({ kind: "upsert", profile: original, changes: { contextWindowTokens: 600_000 } });
  await store.mutate({ kind: "upsert", profile: original, changes: { name: "Renamed" } });
  const [saved] = (await create().read()).profiles;
  assert.equal(saved?.contextWindowTokens, 600_000);
  assert.equal(saved?.name, "Renamed");
});

test("validation sees merged durable settings and rejection leaves the definition unchanged", async (context) => {
  const { create } = await fixture(context);
  const store = create();
  const original = profile("validated", 1);
  await store.mutate({ kind: "upsert", profile: original });
  await store.mutate({ kind: "upsert", profile: original, changes: { model: "new-model" } });
  await assert.rejects(store.mutate({
    kind: "upsert", profile: original, changes: { contextWindowTokens: 500_000 },
  }, async (candidate, previous) => {
    assert.equal(candidate.model, "new-model");
    assert.equal(candidate.contextWindowTokens, 500_000);
    assert.equal(previous?.model, "new-model");
    throw new Error("Model does not support this cap");
  }), /does not support/);
  const [saved] = (await create().read()).profiles;
  assert.equal(saved?.model, "new-model");
  assert.equal(saved?.contextWindowTokens, undefined);
});

test("concurrent field updates merge against durable settings rather than stale browser snapshots", async (context) => {
  const { create } = await fixture(context);
  const store = create();
  const original = profile("alpha", 2);
  await store.mutate({ kind: "upsert", profile: original });
  await Promise.all([
    store.mutate({ kind: "upsert", profile: original, changes: { model: "new-model" } }),
    store.mutate({ kind: "upsert", profile: original, changes: { reasoningEffort: null } }),
  ]);
  const [saved] = (await store.read()).profiles;
  assert.equal(saved?.model, "new-model");
  assert.equal(saved?.reasoningEffort, null);
  assert.equal(saved?.createdAt, original.createdAt);
  await store.mutate({ kind: "delete", profileId: original.id });
  await assert.rejects(store.mutate({ kind: "upsert", profile: original, changes: { name: "resurrected" } }), /does not exist/u);
  assert.deepEqual((await store.read()).profiles, []);
});

test("reads wait on the owned mutation and propagate failure without poisoning later reads", async (context) => {
  const { database, root } = await fixture(context);
  let rejectWrite = false;
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = new WorkbenchComposerProfileStore({
    query: database.query.bind(database),
    executeTransaction: async (statements) => {
      if (rejectWrite) {
        entered();
        await gate;
        throw new Error("Catalogue disk failure");
      }
      return await database.executeTransaction(statements);
    },
  });
  await store.start();
  rejectWrite = true;
  const mutation = assert.rejects(store.mutate({ kind: "upsert", profile: profile("bad", 1) }), /Catalogue disk failure/u);
  await writing;
  const reading = assert.rejects(store.read(), /Catalogue disk failure/u);
  release();
  await Promise.all([mutation, reading]);
  assert.deepEqual((await store.read()).profiles, []);
  await store.dispose();
  await assert.rejects(store.read(), /closed/u);
});

test("disposal rejects new work and drains an accepted catalogue write before replacement", async (context) => {
  const { create, database, root } = await fixture(context);
  let blocked = false;
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = new WorkbenchComposerProfileStore({
    query: database.query.bind(database),
    executeTransaction: async (statements) => {
      if (blocked) { entered(); await gate; }
      return await database.executeTransaction(statements);
    },
  });
  await store.start();
  blocked = true;
  const saving = store.mutate({ kind: "upsert", profile: profile("saved", 1) });
  await writing;
  let disposed = false;
  const disposal = store.dispose().then(() => { disposed = true; });
  await assert.rejects(store.read(), /closed/u);
  assert.equal(disposed, false);
  release();
  await Promise.all([saving, disposal]);
  assert.deepEqual((await create().read()).profiles, [profile("saved", 1)]);
});
