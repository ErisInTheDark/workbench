/* No production exports. Protect persistent-profile lookup and directory deletion scope. */
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController";
import WorkbenchBrowseProfileStore from "./WorkbenchBrowseProfileStore";
import { browseProfiles } from "../database/schema/browse-persistence-schema";
import { upsertRow } from "workbench-shared/database/workbench-database-statements";

test("persistent profiles reopen and forgetting one never removes a sibling directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-browse-profiles-"));
  const profileRoot = path.join(root, "profiles");
  const database = new WorkbenchDatabaseController({ databasePath: path.join(root, "workbench.sqlite3") });
  try {
    const store = new WorkbenchBrowseProfileStore(database, profileRoot);
    assert.equal(await store.resolveProfilePath({ sessionName: "first", persistent: false }), null);
    const first = await store.resolveProfilePath({ sessionName: "first", persistent: true });
    assert.equal(await new WorkbenchBrowseProfileStore(database, profileRoot).resolveProfilePath({ sessionName: "first", persistent: false }), first);
    await mkdir(path.join(profileRoot, "first"), { recursive: true });
    await mkdir(path.join(profileRoot, "second"));
    await writeFile(path.join(profileRoot, "second", "retained"), "browser-owned bytes");
    await database.executeTransaction([upsertRow(browseProfiles, {
      name: "first", created_at: "created", last_used_at: "used", profile_path: profileRoot,
    }, { conflictColumns: ["name"], updateColumns: ["profile_path"] })]);
    await store.forgetPersistentSession("first");
    await access(path.join(profileRoot, "second", "retained"));
    assert.equal(await store.resolveProfilePath({ sessionName: "first", persistent: false }), null);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
