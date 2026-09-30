/* No production exports. Tests protect durable model recency across writes, reads and expiry. */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import path from "node:path";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import { installWorkbenchDatabaseSchema } from "./database/workbench-database-schema";
import WorkbenchModelUsageStore from "./WorkbenchModelUsageStore";
import type { WorkbenchComposerProfileDatabase } from "./WorkbenchComposerProfileStore";

test("accepted model recency is monotonic, durable and expires after seven days", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-model-use-");
  const database = new WorkbenchDatabaseController({
    databasePath: path.join(temporary.path, "workbench.sqlite3"),
  });
  const stores: WorkbenchModelUsageStore[] = [];
  context.after(async () => {
    for (const store of stores) await store.dispose();
    await database.close();
    await temporary.dispose();
  });
  const create = () => {
    const store = new WorkbenchModelUsageStore(database);
    stores.push(store);
    return store;
  };
  const now = 10 * 24 * 60 * 60 * 1000;
  const first = create();
  await first.record("codex", "same", now - 100);
  await first.record("codex", "same", now - 200);
  await first.record("opencode", "same", now - 50);
  await first.record("claude", "expired", now - 7 * 24 * 60 * 60 * 1000 - 1);
  assert.deepEqual(await create().read(now), [
    { harness: "opencode", modelId: "same", lastUsedAt: now - 50 },
    { harness: "codex", modelId: "same", lastUsedAt: now - 100 },
  ]);
  assert.deepEqual(await create().read(now + 7 * 24 * 60 * 60 * 1000 + 1), []);
});

test("an older first write cannot overwrite a newer store during handoff", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-model-handoff-");
  const database = new WorkbenchDatabaseController({
    databasePath: path.join(temporary.path, "workbench.sqlite3"),
  });
  context.after(async () => { await database.close(); await temporary.dispose(); });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delayed: WorkbenchComposerProfileDatabase = {
    query: statement => database.query(statement),
    executeTransaction: async statements => {
      entered.resolve();
      await release.promise;
      return database.executeTransaction(statements);
    },
  };
  const older = new WorkbenchModelUsageStore(delayed);
  const newer = new WorkbenchModelUsageStore(database);
  context.after(async () => { await older.dispose(); await newer.dispose(); });
  const first = older.record("codex", "same", 100);
  await entered.promise;
  await newer.record("codex", "same", 200);
  release.resolve();
  await first;
  assert.deepEqual(await newer.read(200), [{ harness: "codex", modelId: "same", lastUsedAt: 200 }]);
});

test("release 55 adds model recency without changing an existing composer profile", async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-model-migration-");
  context.after(() => temporary.dispose());
  const filename = path.join(temporary.path, "workbench.sqlite3");
  const old = new Database(filename);
  try {
    old.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(old, { targetVersion: 54 });
    old.prepare("INSERT INTO workbench_harnesses(id) VALUES (?)").run("codex");
    old.prepare(`
      INSERT INTO workbench_composer_profiles(id, name, harness, model, scope_kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("kept", "Kept", "codex", "gpt-model", "global", 1, 2);
  } finally { old.close(); }
  const migrated = new Database(filename);
  try {
    migrated.pragma("foreign_keys = ON");
    installWorkbenchDatabaseSchema(migrated);
    assert.deepEqual(migrated.prepare("SELECT name, model FROM workbench_composer_profiles WHERE id = ?").get("kept"),
      { name: "Kept", model: "gpt-model" });
    assert.equal(migrated.prepare("SELECT count(*) FROM workbench_composer_model_usage").pluck().get(), 0);
  } finally { migrated.close(); }
});
