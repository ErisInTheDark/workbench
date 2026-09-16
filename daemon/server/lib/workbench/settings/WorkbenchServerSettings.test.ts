/* No production exports. Protect durable capabilities, update ordering and reopen. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import WorkbenchServerSettings from "./WorkbenchServerSettings.ts";
import WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController.ts";

test("capabilities default safely and serialised updates persist across worker reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-capabilities-"));
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
    await rm(root, { recursive: true, force: true });
  }
});
