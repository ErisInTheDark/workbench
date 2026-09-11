/*
 * Exports:
 * - No production exports; tests cover durable composer-profile mutation semantics.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { WorkbenchComposerProfile } from "workbench-shared/types";
import WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";

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
    const store = new WorkbenchComposerProfileStore(root, database);
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

test("retired legacy profile reads cannot initiate an import write", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-profile-retired-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  const store = new WorkbenchComposerProfileStore(root, {
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

test("rejects malformed legacy catalogue entries rather than importing partial settings", async (context) => {
  const { create, root } = await fixture(context);
  const file = path.join(root, ".workbench", "runtime", "composer-profiles.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ profiles: { valid: profile("valid", 1), broken: { id: "broken" } }, version: 1 }));
  await assert.rejects(create().read(), /invalid.*profile|profile.*invalid/iu);
  await writeFile(file, JSON.stringify({ profiles: { valid: profile("valid", 1) }, version: 1 }));
  assert.deepEqual((await create().read()).profiles, [profile("valid", 1)]);
});

test("imports once and does not resurrect deleted profiles from the retained legacy file", async (context) => {
  const { create, root } = await fixture(context);
  const file = path.join(root, ".workbench", "runtime", "composer-profiles.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, profiles: { old: profile("old", 3) } }));
  const first = create();
  assert.deepEqual((await first.read()).profiles, [profile("old", 3)]);
  await first.mutate({ kind: "delete", profileId: "old" });
  await first.dispose();
  assert.deepEqual((await create().read()).profiles, []);
});

test("reads wait on the owned mutation and propagate failure without poisoning later reads", async (context) => {
  const { database, root } = await fixture(context);
  let rejectWrite = false;
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = new WorkbenchComposerProfileStore(root, {
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

test("failed legacy transactions roll back both imported rows and the completion marker", async (context) => {
  const { create, database, root } = await fixture(context);
  const file = path.join(root, ".workbench", "runtime", "composer-profiles.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, profiles: { old: profile("old", 3) } }));
  const failing = new WorkbenchComposerProfileStore(root, {
    query: database.query.bind(database),
    executeTransaction: async (statements) => {
      // Fail inside SQLite after the rows and marker, not before the transaction starts.
      return await database.executeTransaction([...statements, statements[0]!]);
    },
  });
  await assert.rejects(failing.start(), /unique|constraint/iu);
  await failing.dispose();
  assert.deepEqual((await create().read()).profiles, [profile("old", 3)]);
});

test("disposal rejects new work and drains an accepted catalogue write before replacement", async (context) => {
  const { create, database, root } = await fixture(context);
  let blocked = false;
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = new WorkbenchComposerProfileStore(root, {
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
