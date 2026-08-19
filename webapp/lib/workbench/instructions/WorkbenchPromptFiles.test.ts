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
