/* No production exports. Protect that only other executor generations' surviving command roots are taken, once, and settled commands leave no row. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchDatabaseController from "../WorkbenchDatabaseController";
import WorkbenchExecRootStore from "./WorkbenchExecRootStore";

test("stale roots of earlier generations are taken once; current and settled roots are not", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-exec-roots-");
  const database = new WorkbenchDatabaseController({ databasePath: path.join(temporary.path, "workbench.sqlite3") });
  try {
    const store = new WorkbenchExecRootStore(database, () => 1);
    await Promise.all([
      store.record({ processId: "old-live", generation: "old", pid: 10, startedAt: "133000000000000001" }),
      store.record({ processId: "old-done", generation: "old", pid: 11, startedAt: "2" }),
      store.record({ processId: "current", generation: "now", pid: 12, startedAt: "3" }),
      store.forget("old-done"),
    ]);
    assert.deepEqual(await store.takeStale("now"), [{ processId: "old-live", generation: "old", pid: 10, startedAt: "133000000000000001" }]);
    assert.deepEqual(await store.takeStale("now"), []);
    assert.deepEqual((await new WorkbenchExecRootStore(database).takeStale("later")).map(root => root.processId), ["current"]);
  } finally {
    await database.close();
    await temporary.dispose();
  }
});
