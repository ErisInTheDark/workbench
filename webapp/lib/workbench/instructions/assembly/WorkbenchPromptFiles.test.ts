/* No production exports. Tests protect managed-thread mechanic availability across top-level and subagent contexts. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { listWorkbenchInstructionMechanics } from "./WorkbenchPromptFiles.ts";

test("managed top-level threads expose current-thread mechanics before and after materialization", () => {
  for (const threadId of ["new", "draft:123", "thread-1"]) {
    const context = { harness: "codex" as const, threadId, workbenchOrigin: "http://localhost" };
    const available = listWorkbenchInstructionMechanics(context);
    for (const mechanic of ["thread-title", "thread-status", "thread-git", "thread-recall", "thread-resume"]) {
      assert.equal(available.has(mechanic), true, `${threadId} should expose ${mechanic}`);
    }
  }

  const subagentContext = { harness: "codex" as const, subagentName: "Akari", threadId: "draft:child", workbenchOrigin: "http://localhost" };
  const subagent = listWorkbenchInstructionMechanics(subagentContext);
  assert.equal(subagent.has("thread-title"), false);
  assert.equal(subagent.has("thread-status"), true);
  assert.equal(subagent.has("thread-git"), true);
  assert.equal(subagent.has("thread-recall"), true);
  assert.equal(subagent.has("thread-resume"), true);
});
