/*
 * Exports:
 * - No production exports; tests cover scoped instruction-mechanics availability. Keywords: instructions, title, status, subagent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkbenchGitInstructions,
  listWorkbenchInstructionMechanics,
} from "./WorkbenchPromptFiles.ts";
import { WORKBENCH_AGENTS_PROMPT, WORKBENCH_WORKFLOW_DEFAULT_PROMPT } from "./workbench-prompt-sources.ts";

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

test("default workflow requires title commands before new-thread and new-arc work", () => {
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /setting a concise title is required, not optional/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /as your first command/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /do not wait for inspection/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /before any other arc or task command/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /wb thread title get/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /retitle before resuming task work/u);
});

test("managed Git instructions describe the concise arc move workflow", () => {
  const instructions = buildWorkbenchGitInstructions({
    harness: "codex",
    threadId: "thread-1",
    workbenchOrigin: "http://localhost",
  });
  assert(instructions);
  assert.match(instructions, /wb git arc mv <source> <destination>/u);
  assert.match(instructions, /--map <source> <destination>/u);
  assert.match(instructions, /previews at most 200 sorted mappings/u);
  assert.match(instructions, /repeat it with `--confirm`/u);
  assert.match(instructions, /minimal source and destination claims/u);
  assert.doesNotMatch(instructions, /journal|process death|rollback failure/iu);
});

test("managed Git instructions describe safe linear commit amendments", () => {
  const instructions = buildWorkbenchGitInstructions({
    harness: "codex",
    threadId: "thread-1",
    workbenchOrigin: "http://localhost",
  });
  assert(instructions);
  assert.match(instructions, /wb git commit --amend <commit-sha> --message <message>/u);
  assert.match(instructions, /linear first-parent stack/u);
  assert.match(instructions, /without checking out intermediate history/u);
  assert.match(instructions, /does not run commit hooks/u);
});

test("arc instructions make guarded commands authoritative for workspace state", () => {
  const instructions = buildWorkbenchGitInstructions({
    harness: "codex",
    threadId: "thread-1",
    workbenchOrigin: "http://localhost",
  });
  assert(instructions);

  for (const prompt of [WORKBENCH_AGENTS_PROMPT, instructions]) {
    assert.match(prompt, /run it directly and let it accept or reject the current state/u);
    assert.match(prompt, /Do not inspect or preflight workspace state with raw `git status`, raw `git diff`, or equivalent commands/u);
    assert.doesNotMatch(prompt, /primary source for planned-path drift/u);
  }

  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /Run the required arc command directly without preceding it with raw `git status`, raw `git diff`, `arc compare`, or `arc diff`/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /run `wb git arc continue --ref <current-ref>` directly before another implementation pass/u);
  assert.doesNotMatch(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /use ref-free `arc compare` or `arc diff` for inspection, and `arc continue/u);
  assert.doesNotMatch(instructions, /use ref-free `arc compare` for inspection and `arc continue/u);
});

test("arc instructions describe the complete phase, proposal, and observed-claim lifecycle", () => {
  const instructions = buildWorkbenchGitInstructions({ harness: "codex", threadId: "thread-1", workbenchOrigin: "http://localhost" }) ?? "";
  const required = [
    "wb git arc plan add --", "wb git arc plan remove --", "wb git arc plan adopt --", "wb git arc plan start -m",
    "wb git arc rescind --proposal <proposal-id>", "wb git arc propose --replace <proposal-id>",
    "wb git arc propose --amend <proposal-id>", "Accepted commit proposals", "every dirty file",
    "wb git arc diff --ref <plan-ref> -- <reported-path>", "missing phase", "active", "resolved",
    "already committed", "proposal IDs and commit SHAs", "--adopt <dirty-path>",
    "Any active arc can publish a replacement plan", "does not claim the new paths",
  ];
  assert.deepEqual(required.filter((fragment) => !instructions.includes(fragment)), []);
  assert.doesNotMatch(instructions, /previous claim set remains owned|still owns its previous claim set/u);
  assert.match(instructions, /releases clean previous claims immediately/u);
  assert.match(instructions, /narrowed successor/u);
  assert.match(instructions, /Never use it during Brief or Decision to claim proposed files/u);
  assert.doesNotMatch(instructions, /accepted commits require an explicit replan/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /present one complete revised plan rather than an addendum/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /make every revised plan complete and recoverable on its own/u);
  assert.doesNotMatch(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /addendum plan/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /If the approved plan is unchanged[\s\S]*wb git arc plan start -m/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /If the plan changed[\s\S]*wb git arc plan -m/u);
});
