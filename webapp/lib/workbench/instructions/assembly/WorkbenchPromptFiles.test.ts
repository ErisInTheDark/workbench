/*
 * Exports:
 * - No production exports; tests cover scoped instruction-mechanics availability. Keywords: instructions, title, status, subagent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkbenchGitInstructions,
  filterWorkbenchInstructionContent,
  listWorkbenchInstructionMechanics,
} from "./WorkbenchPromptFiles.ts";
import { WORKBENCH_WORKFLOW_DEFAULT_PROMPT } from "./workbench-prompt-sources.ts";
import {
  buildThreadStatusInstructions,
  buildWorkbenchThreadRecallInstructions,
} from "../mechanics/workbench-instruction-mechanics.ts";
import { buildThreadTitleInstructions } from "../mechanics/workbench-thread-title-instructions.ts";

test("managed top-level threads expose current-thread mechanics before and after materialization", () => {
  for (const threadId of ["new", "draft:123", "thread-1"]) {
    const context = { harness: "codex" as const, threadId, workbenchOrigin: "http://localhost" };
    const available = listWorkbenchInstructionMechanics(context);
    for (const mechanic of ["thread-title", "thread-status", "thread-git", "thread-recall"]) {
      assert.equal(available.has(mechanic), true, `${threadId} should expose ${mechanic}`);
    }
    assert.match(buildThreadTitleInstructions(context) ?? "", /wb thread title --title/u);
    assert.match(buildThreadStatusInstructions(context) ?? "", /wb thread status --status/u);
    assert.match(buildWorkbenchGitInstructions(context) ?? "", /wb git arc plan/u);
    assert.match(buildWorkbenchThreadRecallInstructions(context) ?? "", /wb thread recall/u);
  }

  const subagentContext = { harness: "codex" as const, subagentName: "Akari", threadId: "draft:child", workbenchOrigin: "http://localhost" };
  const subagent = listWorkbenchInstructionMechanics(subagentContext);
  assert.equal(subagent.has("thread-title"), false);
  assert.equal(subagent.has("thread-status"), true);
  assert.equal(subagent.has("thread-git"), true);
  assert.equal(subagent.has("thread-recall"), true);
  assert.equal(buildThreadTitleInstructions(subagentContext), null);
});

test("default workflow filtering retains required thread behavior during materialization", () => {
  const available = listWorkbenchInstructionMechanics({ harness: "codex", threadId: "draft:123", workbenchOrigin: "http://localhost" });
  const warnings: string[] = [];
  const filtered = filterWorkbenchInstructionContent(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, {
    available,
    field: "test.workflow",
    harness: "codex",
    onWarning: (warning) => warnings.push(`${warning.recovery}:${warning.line}`),
    shell: "pwsh",
  });
  assert.match(filtered ?? "", /setting a concise title is required, not optional/u);
  assert.match(filtered ?? "", /wb thread status --status completed/u);
  assert.doesNotMatch(filtered ?? "", /<\/?available:/u);
  assert.deepEqual(warnings, []);
});
