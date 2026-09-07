/*
 * Keywords: thread, native metadata, steer, cwd, tests.
 * Exports:
 * - No production exports; Node tests protect exact-root thread isolation and relationship-owned linked-worktree reads. Keywords: thread, cwd, subagent, worktree, test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isProjectCodexThreadAtExpectedCwd, toThreadTurn } from "./thread-adapter.ts";
import { getWorkbenchInputState, withWorkbenchInputState } from "../workbench/thread/thread-input-item.ts";
import type { Turn } from "./generated/app-server/v2/Turn.ts";

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

test("native turn adaptation converts old steer state while preserving explicit state", () => {
  for (const status of ["pending", "failed", "interrupted", "sent"] as const) {
    const legacy = {
      clientId: null, content: [], id: `workbench:steer-history:${status}:thread:request`, type: "userMessage" as const,
    };
    const turn: Turn = { id: "turn", items: [legacy], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null };
    assert.deepEqual(getWorkbenchInputState(toThreadTurn(turn).items[0]!), { kind: "steer", status });
    turn.items = [withWorkbenchInputState(legacy, { kind: "steer", status: "sent" })];
    assert.deepEqual(getWorkbenchInputState(toThreadTurn(turn).items[0]!), { kind: "steer", status: "sent" });
  }
});
