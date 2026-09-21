/* No production exports. Tests exercise Git content comparison and owned scratch cleanup. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseUnifiedDiff } from "workbench-shared/workbench/thread/unified-diff";
import { diffGitContents } from "./git-content-diff";

test("Git diffs captured contents without retaining scratch files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-diff-test-"));
  try {
    for (const [before, after, additions, deletions] of [
      ["", "new\nsecond", 2, 0],
      ["same\nold\n", "same\nnew\nextra\n", 2, 1],
      ["old\r\n", "new\r\n", 1, 1],
      ["", "", 0, 0],
      ["unchanged\n", "unchanged\n", 0, 0],
    ] as const) {
      const diff = parseUnifiedDiff(await diffGitContents(before, after, { temporaryRoot: root }));
      assert.deepEqual([diff.additions, diff.deletions], [additions, deletions]);
      assert.deepEqual(await fs.readdir(root), []);
    }
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(diffGitContents("before", "after", { temporaryRoot: root, signal: abort.signal }));
    assert.deepEqual(await fs.readdir(root), []);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      await assert.rejects(diffGitContents("before", "after", { temporaryRoot: root }));
      assert.deepEqual(await fs.readdir(root), [], "failed Git launches also dispose both snapshots");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
