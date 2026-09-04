/*
 * No production exports. Regression wards protect large literal path sets and read-only worktree change detection.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import ReloadDirtSnapshotRepository from "./ReloadDirtSnapshotRepository.ts";

const run = promisify(execFile);

async function listObjectPaths(rootPath: string) {
  const paths: string[] = [];
  const visit = async (directoryPath: string, relativePath: string) => {
    for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      const entryRelativePath = path.posix.join(relativePath, entry.name);
      if (entry.isDirectory()) await visit(entryPath, entryRelativePath);
      else paths.push(entryRelativePath);
    }
  };
  await visit(path.join(rootPath, ".git", "objects"), "");
  return paths.sort();
}

test("large scoped reads preserve exact path ownership without writing Git objects", async (context) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-reload-snapshot-"));
  const git = async (...args: string[]) => await run("git", args, { cwd: repoRoot });
  context.after(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  });
  await git("init");
  await git("config", "user.email", "workbench@example.invalid");
  await git("config", "user.name", "Workbench test");
  await fs.mkdir(path.join(repoRoot, "sources"), { recursive: true });

  const missingSourcePaths = Array.from({ length: 220 }, (_, index) => (
    `sources/retired-${String(index).padStart(3, "0")}-${"x".repeat(132)}.ts`
  ));
  const editedPath = "sources/edited.ts";
  const deletedPath = "sources/deleted.ts";
  const untrackedBaselinePath = "sources/untracked-baseline.ts";
  await fs.writeFile(path.join(repoRoot, editedPath), "export const edited = false;\n", "utf8");
  await fs.writeFile(path.join(repoRoot, deletedPath), "export const deleted = false;\n", "utf8");
  await fs.writeFile(path.join(repoRoot, untrackedBaselinePath), "export const untracked = false;\n", "utf8");
  await fs.mkdir(path.join(repoRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "nested", "owned.ts"), "export const nested = false;\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "outside.ts"), "export const outside = 1;\n", "utf8");
  await git("add", ".");
  await git("commit", "-m", "initial");
  const baseline = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("rm", "--cached", untrackedBaselinePath);
  await git("commit", "-m", "stop tracking baseline source");

  const literalPath = "sources/[literal].ts";
  await fs.writeFile(path.join(repoRoot, editedPath), "export const edited = true;\n", "utf8");
  await fs.rm(path.join(repoRoot, deletedPath));
  await fs.writeFile(path.join(repoRoot, literalPath), "export const literal = true;\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "nested", "owned.ts"), "export const nested = true;\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "outside.ts"), "export const outside = 2;\n", "utf8");

  const repository = new ReloadDirtSnapshotRepository(repoRoot);
  const selectedPaths = [
    ...missingSourcePaths,
    editedPath,
    deletedPath,
    literalPath,
    untrackedBaselinePath,
    "nested",
  ];
  const objectsBefore = await listObjectPaths(repoRoot);

  assert.deepEqual(
    await repository.listWorktreeChangedPaths(baseline, selectedPaths),
    [deletedPath, editedPath, literalPath, "nested/owned.ts"].sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(await repository.listWorktreeChangedPaths(baseline, ["outside.ts"]), ["outside.ts"]);
  await fs.writeFile(path.join(repoRoot, untrackedBaselinePath), "export const untracked = true;\n", "utf8");
  assert.deepEqual(
    await repository.listWorktreeChangedPaths(baseline, [untrackedBaselinePath]),
    [untrackedBaselinePath],
  );
  assert.deepEqual(await listObjectPaths(repoRoot), objectsBefore);
});
