/* No production exports. Protect durable capabilities, update ordering and reopen. */
import assert from "node:assert/strict";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { test } from "node:test";
import WorkbenchServerSettings from "./WorkbenchServerSettings.ts";
import WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController.ts";
import { THREAD_AUTO_COMPACT_DEFAULTS } from "workbench-shared/workbench/settings/thread-auto-compact";

test("per-provider compaction rules merge independent edits, leave other providers on defaults, and persist across reopen", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-auto-compact-");
  const options = { databasePath: path.join(temporary.path, "workbench.sqlite3") };
  let database = new WorkbenchDatabaseController(options);
  try {
    const settings = new WorkbenchServerSettings(database);
    assert.deepEqual(await settings.readThreadAutoCompact(), THREAD_AUTO_COMPACT_DEFAULTS);
    await Promise.all([
      settings.updateThreadAutoCompact("claude", { tokenThreshold: 250_000 }),
      settings.updateThreadAutoCompact("claude", { idleMinutes: 40 }),
      settings.updateThreadAutoCompact("claude", { enabled: false }),
      settings.updateThreadAutoCompact("codex", { turnEndTokenThreshold: 300_000 }),
    ]);
    await assert.rejects(settings.updateThreadAutoCompact("codex", { idleMinutes: 30 }), /no idle compaction rule/);
    await database.close();
    database = new WorkbenchDatabaseController(options);
    assert.deepEqual(await new WorkbenchServerSettings(database).readThreadAutoCompact(), {
      ...THREAD_AUTO_COMPACT_DEFAULTS,
      claude: { enabled: false, idle: { tokenThreshold: 250_000, minutes: 40 }, turnEndTokenThreshold: 500_000 },
      codex: { ...THREAD_AUTO_COMPACT_DEFAULTS.codex, turnEndTokenThreshold: 300_000 },
    });
  } finally {
    await database.close();
    await temporary.dispose();
  }
});

test("capabilities default safely and serialised updates persist across worker reopen", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-capabilities-");
  const root = temporary.path;
  const options = { databasePath: path.join(root, "workbench.sqlite3") };
  let database = new WorkbenchDatabaseController(options);
  try {
    const settings = new WorkbenchServerSettings(database);
    assert.deepEqual(await settings.readLocalCapabilities(), { browseRawCommandsEnabled: false });
    await Promise.all([
      settings.updateLocalCapabilities(current => ({ browseRawCommandsEnabled: !current.browseRawCommandsEnabled })),
      settings.updateLocalCapabilities(current => ({ browseRawCommandsEnabled: !current.browseRawCommandsEnabled })),
    ]);
    assert.deepEqual(await settings.readLocalCapabilities(), { browseRawCommandsEnabled: false });
    await settings.writeLocalCapabilities({ browseRawCommandsEnabled: true });
    await database.close();
    database = new WorkbenchDatabaseController(options);
    assert.deepEqual(await new WorkbenchServerSettings(database).readLocalCapabilities(), { browseRawCommandsEnabled: true });
  } finally {
    await database.close();
    await temporary.dispose();
  }
});

test("discovery folders start empty and replace atomically in order across reopen", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-discovery-settings-");
  const root = temporary.path;
  const options = { databasePath: path.join(root, "workbench.sqlite3") };
  let database = new WorkbenchDatabaseController(options);
  try {
    let settings = new WorkbenchServerSettings(database);
    assert.deepEqual(await settings.readProjectDiscoveryRoots(), []);
    await settings.replaceProjectDiscoveryRoots(["C:/first", "D:/second"]);
    assert.deepEqual(await settings.readProjectDiscoveryRoots(), ["C:/first", "D:/second"]);
    await database.close();
    database = new WorkbenchDatabaseController(options);
    settings = new WorkbenchServerSettings(database);
    assert.deepEqual(await settings.readProjectDiscoveryRoots(), ["C:/first", "D:/second"]);
    await settings.replaceProjectDiscoveryRoots([]);
    assert.deepEqual(await settings.readProjectDiscoveryRoots(), []);
  } finally {
    await database.close();
    await temporary.dispose();
  }
});
