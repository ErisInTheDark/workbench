/* Exports: none. Tests cover wb rm validation, claim gating, and deletion. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import WorkbenchFileRemovalController, { type WorkbenchFileRemovalClaimCheck } from "./WorkbenchFileRemovalController";

async function workspace() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wb-rm-"));
  await fs.writeFile(path.join(cwd, "claimed.ts"), "a");
  await fs.writeFile(path.join(cwd, "other.ts"), "b");
  await fs.mkdir(path.join(cwd, "folder"));
  await fs.writeFile(path.join(cwd, "folder", "inner.ts"), "c");
  return cwd;
}

const exists = async (target: string) => await fs.access(target).then(() => true, () => false);

function claimsCovering(cwd: string, claimed: readonly string[]): WorkbenchFileRemovalClaimCheck {
  const covered = new Set(claimed.map(entry => path.resolve(cwd, entry)));
  return async ({ paths }) => {
    const uncoveredPaths = paths.filter(entry => !covered.has(entry));
    return { allowed: uncoveredPaths.length === 0, pendingProposals: [], uncoveredPaths };
  };
}

async function remove(controller: WorkbenchFileRemovalController, cwd: string, paths: string[], recursive = false) {
  const response = await controller.execute({ cwd, harness: "claude", paths, recursive, threadId: "wb-thread" }, new AbortController().signal);
  return { ok: response.ok, text: await response.text() };
}

test("an unclaimed path rejects the whole removal and deletes nothing", async () => {
  const cwd = await workspace();
  try {
    const result = await remove(new WorkbenchFileRemovalController(claimsCovering(cwd, ["claimed.ts"])), cwd, ["claimed.ts", "other.ts"]);
    assert.equal(result.ok, false);
    assert.match(result.text, /Unclaimed paths/u);
    assert.equal(await exists(path.join(cwd, "claimed.ts")), true);
    assert.equal(await exists(path.join(cwd, "other.ts")), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("invalid targets reject before claims are checked or anything is deleted", async () => {
  const cwd = await workspace();
  let checked = false;
  const controller = new WorkbenchFileRemovalController(async ({ paths }) => {
    checked = true;
    return { allowed: true, pendingProposals: [], uncoveredPaths: paths.slice(0, 0) };
  });
  try {
    for (const [paths, recursive] of [[["claimed.ts", "missing.ts"], false], [["folder"], false], [["."], true], [[".."], true]] as const) {
      const result = await remove(controller, cwd, [...paths], recursive);
      assert.equal(result.ok, false, paths.join(","));
    }
    assert.equal(checked, false);
    assert.equal(await exists(path.join(cwd, "claimed.ts")), true);
    assert.equal(await exists(path.join(cwd, "folder", "inner.ts")), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("removal deletes links and junctions themselves, never what they point at", async () => {
  const cwd = await workspace();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wb-rm-target-"));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    await fs.writeFile(path.join(outside, "precious.txt"), "keep");
    await fs.symlink(outside, path.join(cwd, "folder", "nested-link"), linkType);
    await fs.symlink(outside, path.join(cwd, "top-link"), linkType);
    const controller = new WorkbenchFileRemovalController(claimsCovering(cwd, ["folder", "top-link"]));
    const result = await remove(controller, cwd, ["folder", "top-link"], true);
    assert.equal(result.ok, true, result.text);
    assert.equal(await exists(path.join(cwd, "folder")), false);
    assert.equal(await fs.lstat(path.join(cwd, "top-link")).then(() => true, () => false), false);
    assert.equal(await exists(path.join(outside, "precious.txt")), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("claimed files and recursive directories are deleted", async () => {
  const cwd = await workspace();
  try {
    const controller = new WorkbenchFileRemovalController(claimsCovering(cwd, ["claimed.ts", "folder"]));
    const result = await remove(controller, cwd, ["claimed.ts", path.join(cwd, "folder")], true);
    assert.equal(result.ok, true, result.text);
    assert.equal(await exists(path.join(cwd, "claimed.ts")), false);
    assert.equal(await exists(path.join(cwd, "folder")), false);
    assert.equal(await exists(path.join(cwd, "other.ts")), true);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
