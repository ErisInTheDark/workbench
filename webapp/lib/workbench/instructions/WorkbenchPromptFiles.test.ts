/*
 * Exports:
 * - No production exports; tests cover scoped instruction-mechanics availability. Keywords: instructions, title, status, subagent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { listWorkbenchInstructionMechanics } from "./WorkbenchPromptFiles.ts";

test("materialized top-level threads expose title/status while subagents omit title", () => {
  const topLevel = listWorkbenchInstructionMechanics({ harness: "codex", threadId: "thread-1", workbenchOrigin: "http://localhost" });
  assert.equal(topLevel.has("thread-title"), true);
  assert.equal(topLevel.has("thread-status"), true);
  assert.equal(topLevel.has("subagents"), true);

  const subagent = listWorkbenchInstructionMechanics({ harness: "codex", subagentName: "Akari", threadId: "thread-2", workbenchOrigin: "http://localhost" });
  assert.equal(subagent.has("thread-title"), false);
  assert.equal(subagent.has("thread-status"), true);
});

test("blank and durable drafts expose no managed-thread mechanics", () => {
  for (const threadId of ["new", "draft:123"]) {
    const available = listWorkbenchInstructionMechanics({ harness: "codex", threadId, workbenchOrigin: "http://localhost" });
    assert.equal(available.has("thread-title"), false);
    assert.equal(available.has("thread-status"), false);
  }
});
