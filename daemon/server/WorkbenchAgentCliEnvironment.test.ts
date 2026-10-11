/* No exports. Tests protect local test and checkout command shim dispatch with cwd isolation. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchAgentCliEnvironment from "./WorkbenchAgentCliEnvironment";

test("generated shims dispatch local tests only from their owning repository", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cleanupTemporary = await WorkbenchTemporaryDirectory.create("wb-test-shim-");
  const temporary = cleanupTemporary.path;
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
    await cleanupTemporary.dispose();
  }
});

test("generated shims dispatch ports through their owning checkout", async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const cleanupTemporary = await WorkbenchTemporaryDirectory.create("wb-ports-shim-");
  const root = cleanupTemporary.path;
  try {
    const shellSourcePath = path.join(root, "daemon/server/lib/workbench/cli/workbench-agent-cli.sh");
    const resolverSourcePath = path.join(root, "daemon/server/lib/workbench/cli/resolve-workbench-daemon-origin.mts");
    const checkoutCliPath = path.join(root, "cli/dispatch.mjs");
    await mkdir(path.dirname(shellSourcePath), { recursive: true });
    await mkdir(path.dirname(checkoutCliPath), { recursive: true });
    await writeFile(
      shellSourcePath,
      await readFile(path.join(repositoryRoot, "daemon/server/lib/workbench/cli/workbench-agent-cli.sh"), "utf8"),
    );
    await writeFile(checkoutCliPath, "process.stdout.write(`native:${process.argv.slice(2).join(' ')}\\n`);\n");
    const installed = await new WorkbenchAgentCliEnvironment({
      resolverSourcePath,
      runtimeDirectoryPath: path.join(root, "daemon/node_modules/.bin"),
      shellSourcePath,
    }).install({});

    const result = await promisify(execFile)("bash", [installed.posixShimPath, "ports"], {
      cwd: root,
      env: { ...process.env, WORKBENCH_THREAD_ID: "managed-thread" },
    });
    assert.equal(result.stdout, "native:ports\n");
    assert.equal(result.stderr, "");
  } finally {
    await cleanupTemporary.dispose();
  }
});
