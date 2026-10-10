/*
 * No production exports. Protect orphaned index-lock removal: only provably dead, incomplete locks are removed.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import GitIndexLock from "./GitIndexLock";

const execute = promisify(execFile);
const windowsOnly = { skip: process.platform !== "win32" && "handle-exclusivity proof is Windows-only" };

async function repositoryIndex(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-index-lock-");
  context.after(async () => await temporary.dispose());
  const root = temporary.path;
  await execute("git", ["init", "-q", root], { windowsHide: true });
  await fs.writeFile(path.join(root, "file.txt"), "content\n");
  await execute("git", ["-C", root, "add", "file.txt"], { windowsHide: true });
  const indexPath = path.join(root, ".git", "index");
  return { indexPath, lockPath: `${indexPath}.lock`, index: await fs.readFile(indexPath) };
}

test("absent locks need no recovery", async (context) => {
  const { indexPath } = await repositoryIndex(context);
  assert.equal(await GitIndexLock.clearOrphan(indexPath), "absent");
});

test("complete index locks are kept because a live commit may still be running hooks", async (context) => {
  const { index, indexPath, lockPath } = await repositoryIndex(context);
  await fs.writeFile(lockPath, index);
  assert.equal(await GitIndexLock.clearOrphan(indexPath), "complete");
  assert.deepEqual(await fs.readFile(lockPath), index);
});

test("unheld empty and truncated locks are removed as orphans", windowsOnly, async (context) => {
  const { index, indexPath, lockPath } = await repositoryIndex(context);
  const warn = context.mock.method(console, "warn", () => {});
  for (const bytes of [Buffer.alloc(0), index.subarray(0, index.length - 7)]) {
    await fs.writeFile(lockPath, bytes);
    assert.equal(await GitIndexLock.clearOrphan(indexPath), "removed");
    await assert.rejects(fs.stat(lockPath), { code: "ENOENT" });
  }
  assert.deepEqual(await fs.readFile(indexPath), index);
  assert.equal(warn.mock.callCount(), 2);
});

test("incomplete locks with a live handle are kept", windowsOnly, async (context) => {
  const { indexPath, lockPath } = await repositoryIndex(context);
  const writer = await fs.open(lockPath, "wx");
  try {
    assert.equal(await GitIndexLock.clearOrphan(indexPath), "held");
    await fs.stat(lockPath);
  } finally {
    await writer.close();
  }
});
