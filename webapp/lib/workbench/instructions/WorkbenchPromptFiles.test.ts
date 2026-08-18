/*
 * Exports:
 * - No production exports; tests cover scoped instruction-mechanics availability, including thread-owned Git workflows. Keywords: instructions, title, status, subagent, git checkpoint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkbenchGitInstructions,
  listWorkbenchInstructionMechanics,
} from "./WorkbenchPromptFiles.ts";
import {
  WORKBENCH_AGENTS_PROMPT,
  WORKBENCH_WORKFLOW_DEFAULT_PROMPT,
} from "./workbench-base-prompts.ts";

test("materialized top-level threads expose title/status while subagents omit title", () => {
  const topLevel = listWorkbenchInstructionMechanics({ harness: "codex", threadId: "thread-1", workbenchOrigin: "http://localhost" });
  assert.equal(topLevel.has("thread-title"), true);
  assert.equal(topLevel.has("thread-status"), true);
  assert.equal(topLevel.has("subagents"), true);
  assert.equal(topLevel.has("thread-git"), true);

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

test("checkpoint instructions explain full snapshots, verified paths, and Review proposals", async () => {
  const utilityInstructions = buildWorkbenchGitInstructions({
    harness: "codex",
    threadId: "thread-1",
    workbenchOrigin: "http://localhost",
  });
  assert.match(utilityInstructions ?? "", /snapshot the full Git-visible worktree as structurally shared Git objects/u);
  assert.match(utilityInstructions ?? "", /verified planned set; they are not the checkpoint's storage scope or an ownership boundary/u);
  assert.match(utilityInstructions ?? "", /Amendment preserves the original snapshot tree and parent/u);
  assert.match(utilityInstructions ?? "", /does not establish a new snapshot baseline/u);
  assert.match(utilityInstructions ?? "", /exact path list selects the compare operation from the checkpoint's full snapshot/u);
  assert.doesNotMatch(utilityInstructions ?? "", /scope is mechanically enforced/u);
  assert.match(utilityInstructions ?? "", /checkpoint compare\/diff` as the primary source for planned-path drift and Review/u);
  assert.match(utilityInstructions ?? "", /Do not repeat a successful checkpoint check with raw `git status` or `git diff`/u);
  assert.match(utilityInstructions ?? "", /Compatible fast-forward commits to unrelated paths do not block selected-path restore/u);
  assert.match(utilityInstructions ?? "", /agent must run this command[\s\S]*editable commit proposal UI/u);
  assert.match(utilityInstructions ?? "", /does not commit the branch and does not require separate commit permission/u);
  assert.match(utilityInstructions ?? "", /Omit the optional description when the title already explains the commit/u);
  assert.match(utilityInstructions ?? "", /Add a description only when it communicates useful context that the title cannot/u);

  assert.match(WORKBENCH_AGENTS_PROMPT, /compatible fast-forward HEAD commit/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /checkpoint compare\/diff` as the primary source for planned-path drift and Review/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /full Git-visible worktree snapshot for one implementation arc/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /Amendment preserves the original snapshot tree and parent/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /not a new or combined snapshot baseline/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /exact paths select the proposal from the full snapshot/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /run `wb git checkpoint commit[\s\S]*editable commit proposal UI/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /Omit the optional description when the title already explains the commit/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /create a full-worktree implementation checkpoint before the first file edit/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /path list selects the comparison from the full snapshot/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /after validation, checkpoint compare\/diff, and the Review summary[\s\S]*editable commit proposal UI/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /Add a description only when it communicates useful context that the title cannot/u);
});
