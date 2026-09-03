/*
 * Exports:
 * - No production exports; Node tests protect exact-root thread isolation and relationship-owned linked-worktree reads. Keywords: thread, cwd, subagent, worktree, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isProjectCodexThreadAtExpectedCwd } from "./thread-adapter.ts";

test("relationship-owned cwd permits an exact linked-worktree thread without broadening project membership", () => {
  const projectRoot = "C:/git/web/workbench";
  const linkedWorktree = "C:/git/web/workbench/.workbench/worktrees/convex-lab";

  assert.equal(isProjectCodexThreadAtExpectedCwd({ cwd: linkedWorktree }, projectRoot, null), false);
  assert.equal(isProjectCodexThreadAtExpectedCwd({ cwd: linkedWorktree }, projectRoot, linkedWorktree), true);
  assert.equal(isProjectCodexThreadAtExpectedCwd({ cwd: `${linkedWorktree}/nested` }, projectRoot, linkedWorktree), false);
  assert.equal(isProjectCodexThreadAtExpectedCwd({ cwd: "C:/git/web/other" }, projectRoot, "C:/git/web/other"), false);
  assert.equal(isProjectCodexThreadAtExpectedCwd(
    { cwd: "c:\\git\\web\\workbench\\.workbench\\worktrees\\convex-lab" },
    projectRoot,
    linkedWorktree,
  ), true);
});
