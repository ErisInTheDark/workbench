/* No exports. Tests protect local-test shim dispatch and cwd isolation. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";

test("generated shims dispatch local tests only from their owning repository", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wb-test-shim-"));
  try {
    const installed = await new WorkbenchAgentCliEnvironment({
      resolverSourcePath: path.join(root, "daemon/server/lib/workbench/cli/resolve-workbench-daemon-origin.mts"),
      runtimeDirectoryPath: temporary,
      shellSourcePath: path.join(root, "daemon/server/lib/workbench/cli/workbench-agent-cli.sh"),
    }).install({});
    const invoke = (cwd: string) => promisify(execFile)("bash", [installed.posixShimPath, "test", "--help"], {
      cwd, env: { ...process.env, WORKBENCH_CWD_REDIRECTED: "1" },
    });
    assert.match((await invoke(root)).stdout, /wb test/);
    await assert.rejects(invoke(temporary), error => {
      assert.match((error as Error & { stderr: string }).stderr, /repository root/);
      return true;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
