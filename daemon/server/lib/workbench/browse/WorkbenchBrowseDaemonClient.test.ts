/*
 * No production exports. Node tests protect project-local Browse daemon runtime paths and session cleanup. Keywords: browse, daemon, temp, reload.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import WorkbenchBrowseDaemonClient from "./WorkbenchBrowseDaemonClient";

test("defaults new daemon runtime files to the Workbench project temp root", () => {
  const client = new WorkbenchBrowseDaemonClient();
  assert.equal(
    path.relative(WorkbenchTemporaryDirectory.projectRootPath, client.getRuntimeDirectoryPath()).startsWith(".."),
    false,
  );
});

test("discovers and cleans sessions from the daemon runtime", async (context) => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-browse-daemon-client-");
  const root = temporary.path;
  context.after(async () => await temporary.dispose());
  const runtimeDirectoryPath = path.join(root, "runtime");
  await fs.mkdir(runtimeDirectoryPath, { recursive: true });
  const pidPath = path.join(runtimeDirectoryPath, "research.pid");
  await fs.writeFile(pidPath, "123\n", "utf8");
  const client = new WorkbenchBrowseDaemonClient({ runtimeDirectoryPath });

  assert.deepEqual(await client.listRuntimeSessionNames(), ["research"]);
  assert.equal(await client.readPid("research"), 123);
  await client.cleanupRuntimeFiles("research");
  await assert.rejects(fs.stat(pidPath), { code: "ENOENT" });
});
