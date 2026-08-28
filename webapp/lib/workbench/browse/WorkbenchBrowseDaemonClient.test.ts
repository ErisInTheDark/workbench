/*
 * No production exports. Node tests protect project-local Browse daemon paths and legacy runtime discovery during reload compatibility. Keywords: browse, daemon, temp, reload, compatibility.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
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

test("discovers and cleans sessions from the legacy daemon runtime", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-browse-daemon-client-"));
  context.after(async () => await fs.rm(root, { force: true, recursive: true }));
  const runtimeDirectoryPath = path.join(root, "current");
  const legacyRuntimeDirectoryPath = path.join(root, "legacy");
  await fs.mkdir(legacyRuntimeDirectoryPath, { recursive: true });
  const legacyPidPath = path.join(legacyRuntimeDirectoryPath, "research.pid");
  await fs.writeFile(legacyPidPath, "123\n", "utf8");
  const client = new WorkbenchBrowseDaemonClient({ legacyRuntimeDirectoryPath, runtimeDirectoryPath });

  assert.deepEqual(await client.listRuntimeSessionNames(), ["research"]);
  assert.equal(await client.readPid("research"), 123);
  await client.cleanupRuntimeFiles("research");
  await assert.rejects(fs.stat(legacyPidPath), { code: "ENOENT" });
});
