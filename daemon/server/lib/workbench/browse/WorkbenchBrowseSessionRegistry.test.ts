/* No production exports. Protect durable session ownership and inactivity transitions. */
import assert from "node:assert/strict";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController";
import WorkbenchBrowseSessionRegistry from "./WorkbenchBrowseSessionRegistry";
import { insertRow } from "workbench-shared/database/workbench-database-statements";
import { projectTables } from "workbench-shared/workbench/database/schema/project-schema";

test("session updates preserve other owners and retain the first inactive timestamp", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-browse-registry-"));
  const database = new WorkbenchDatabaseController({ databasePath: path.join(root, "workbench.sqlite3") });
  try {
    await database.executeTransaction([insertRow(projectTables.projects, { id: testProjectIds.repo })]);
    let now = 1000;
    const registry = new WorkbenchBrowseSessionRegistry(database, () => now);
    await Promise.all(["a", "b"].map(name => registry.remember({
      name, threadId: name, cwd: "/repo", mode: "headless", projectId: testProjectIds.repo, projectRootPath: "/repo",
    })));
    await registry.markThreadInactive("a");
    now = 2000;
    await registry.markThreadInactive("a");
    const [inactive] = await registry.listStaleInactiveSessions({ now, olderThanMs: 1000 });
    assert.equal(inactive.name, "a");
    assert.equal(inactive.inactiveSince, new Date(1000).toISOString());
    await registry.markThreadActive("a");
    assert.deepEqual(await registry.listStaleInactiveSessions({ now, olderThanMs: 0 }), []);
    await registry.forget("a");
    assert.deepEqual((await new WorkbenchBrowseSessionRegistry(database).list()).map(session => session.name), ["b"]);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
