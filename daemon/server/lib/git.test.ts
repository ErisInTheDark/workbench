/*
 * No production exports. Protect read-only origin parsing without checkout trust and Git-directory classification.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readGitProjectMetadata, resolveGitDirectory } from "./git";

const execute = promisify(execFile);
const readerPath = path.join(__dirname, "git.ts");

test("missing Git HEAD markers are not repositories, while an unborn checkout is", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-git-marker-"));
  context.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const empty = path.join(root, "empty");
  const brokenLink = path.join(root, "broken-link");
  const unborn = path.join(root, "unborn");
  await fs.mkdir(path.join(empty, ".git"), { recursive: true });
  await fs.mkdir(brokenLink);
  await fs.writeFile(path.join(brokenLink, ".git"), "gitdir: ../missing-gitdir\n");
  await execute("git", ["init", "-q", unborn], { windowsHide: true });

  assert.equal(await resolveGitDirectory(empty), null);
  assert.equal(await readGitProjectMetadata(empty), null);
  assert.equal(await resolveGitDirectory(brokenLink), null);
  assert.ok(await resolveGitDirectory(unborn));
  assert.ok(await readGitProjectMetadata(unborn));
});

test("origin parsing does not require trusting a checkout owned by another identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-origin-trust-"));
  // Tighten only this probe's trust policy so an inherited fixture allowlist cannot mask the failure.
  const env = {
    ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "",
  };
  try {
    await execute("git", ["init", "-q", root], { windowsHide: true });
    await fs.appendFile(path.join(root, ".git", "config"), '\n[remote "origin"]\nurl = https://example.test/owner/repo.git\n');
    await assert.rejects(execute("git", ["-C", root, "rev-parse", "--show-toplevel"], { env, windowsHide: true }),
      (error: Error & { stderr?: string }) => /dubious ownership/u.test(error.stderr ?? ""));
    const result = await execute(process.execPath, [
      "--import", "tsx", "-e",
      `const { readGitProjectMetadata } = require(${JSON.stringify(readerPath)}); readGitProjectMetadata(process.argv[1]).then(value => process.stdout.write(JSON.stringify(value)));`,
      root,
    ], { env, windowsHide: true });
    assert.deepEqual(JSON.parse(result.stdout), {
      origin: "https://example.test/owner/repo.git",
      linkedWorktree: false,
      commonGitDirectory: await fs.realpath(path.join(root, ".git")),
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("local config parsing preserves Git syntax, separate directories, absent origins, and malformed-file failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-origin-config-"));
  const checkout = path.join(root, "checkout");
  const metadata = path.join(root, "metadata");
  try {
    await execute("git", ["init", "-q", `--separate-git-dir=${metadata}`, checkout], { windowsHide: true });
    const commonGitDirectory = await fs.realpath(metadata);
    assert.deepEqual(await readGitProjectMetadata(checkout), { origin: null, linkedWorktree: false, commonGitDirectory });
    const config = path.join(metadata, "config");
    const original = await fs.readFile(config, "utf8");
    await fs.writeFile(path.join(metadata, "included"), '[remote "origin"]\nurl = https://wrong.test/repo\n');
    await fs.writeFile(config, `${original}\n[include]\npath = included\n[remote "origin"]\nurl = "https://example.test/owner/repo.git" # retained syntax\n`);
    assert.deepEqual(await readGitProjectMetadata(checkout), { origin: "https://example.test/owner/repo.git", linkedWorktree: false, commonGitDirectory });
    await fs.writeFile(config, `${original}\n[include]\npath = included\n`);
    assert.deepEqual(await readGitProjectMetadata(checkout), { origin: null, linkedWorktree: false, commonGitDirectory });
    await fs.writeFile(config, "[broken");
    await assert.rejects(readGitProjectMetadata(checkout));
    await fs.rename(config, path.join(metadata, "saved-config"));
    assert.deepEqual(await readGitProjectMetadata(checkout), { origin: null, linkedWorktree: false, commonGitDirectory });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("linked worktrees reject malformed common repository configuration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-origin-worktree-"));
  const main = path.join(root, "main");
  const linked = path.join(root, "linked");
  try {
    await execute("git", ["init", "-q", main], { windowsHide: true });
    await execute("git", ["-C", main, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture"], { windowsHide: true });
    await execute("git", ["-C", main, "worktree", "add", "--detach", linked], { windowsHide: true });
    await fs.writeFile(path.join(main, ".git", "config"), "[invalid");
    await assert.rejects(readGitProjectMetadata(linked));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("linked worktrees share repository origin identity without trusting the worktree config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-linked-origin-"));
  const main = path.join(root, "main");
  const linked = path.join(root, "linked");
  try {
    await execute("git", ["init", "-q", main], { windowsHide: true });
    await execute("git", ["-C", main, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture"], { windowsHide: true });
    await execute("git", ["-C", main, "remote", "add", "origin", "https://example.test/owner/repo.git"], { windowsHide: true });
    await execute("git", ["-C", main, "worktree", "add", "--detach", linked], { windowsHide: true });
    assert.equal((await readGitProjectMetadata(main))?.origin, "https://example.test/owner/repo.git");
    assert.equal((await readGitProjectMetadata(linked))?.origin, "https://example.test/owner/repo.git");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
