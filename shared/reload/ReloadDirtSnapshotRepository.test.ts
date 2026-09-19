/*
 * No production exports. Regression wards protect large literal path sets and read-only worktree change detection.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import ReloadDirtSnapshotRepository from "./ReloadDirtSnapshotRepository.ts";

const run = promisify(execFile);

test("scoped reload checks do not open unrelated worktree files", { skip: process.platform !== "win32" }, async (context) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-reload-read-boundary-"));
  context.after(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
  });
  const git = async (...args: string[]) => await run("git", args, { cwd: repoRoot });
  await git("init");
  await git("config", "user.email", "workbench@example.invalid");
  await git("config", "user.name", "Workbench test");
  await fs.writeFile(path.join(repoRoot, "source.ts"), "before\n");
  const unrelatedPath = path.join(repoRoot, "editor.tsx");
  await fs.writeFile(unrelatedPath, "before\n");
  await git("add", ".");
  await git("commit", "-m", "baseline");
  await fs.writeFile(path.join(repoRoot, "source.ts"), "after!\n");
  await fs.writeFile(unrelatedPath, "after!\n");
  const probePath = path.join(repoRoot, "read-probe.cjs");
  const markerPath = path.join(repoRoot, "unrelated-read");
  await fs.writeFile(probePath, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'opened');`,
    "process.stdout.write(fs.readFileSync(0));",
  ].join("\n"));
  await fs.writeFile(path.join(repoRoot, ".gitattributes"), "editor.tsx filter=read-probe\n");
  await git("config", "filter.read-probe.clean", `"${process.execPath.replaceAll("\\", "/")}" "${probePath.replaceAll("\\", "/")}"`);
  const repository = new ReloadDirtSnapshotRepository(repoRoot);
  assert.deepEqual(await repository.listWorktreeChangedPaths("HEAD", ["source.ts"]), ["source.ts"]);
  await assert.rejects(fs.access(markerPath), { code: "ENOENT" }, "unrelated files must not be read or passed through clean filters");

  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
    "$ErrorActionPreference = 'Stop'",
    "$file = [System.IO.File]::Open($env:WORKBENCH_LOCKED_TEST_FILE, 'Open', 'Read', 'None')",
    "try { [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null } finally { $file.Dispose() }",
  ].join("; ")], {
    env: { ...process.env, WORKBENCH_LOCKED_TEST_FILE: unrelatedPath },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  holder.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  const exited = new Promise<void>((resolve, reject) => {
    holder.once("error", reject);
    holder.once("exit", code => code === 0 ? resolve() : reject(new Error(`Lock holder failed (${code}): ${stderr}`)));
  });
  const ready = new Promise<void>((resolve, reject) => {
    holder.stdout.once("data", () => resolve());
    void exited.then(() => reject(new Error("Lock holder exited before readiness.")), reject);
  });
  try {
    await ready;
    await assert.rejects(fs.readFile(unrelatedPath));
    assert.deepEqual(await repository.listWorktreeChangedPaths("HEAD", ["source.ts"]), ["source.ts"]);
  } finally {
    holder.stdin.end("\n");
    await exited;
  }
});

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
