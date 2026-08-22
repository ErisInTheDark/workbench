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
import { readInstructionSource } from "../instruction-source.ts";
import {
  buildWorkbenchBrowseInstructions,
  buildWorkbenchOrchestratorReloadInstructions,
  buildWorkbenchSubagentInstructions,
  buildThreadStatusInstructions,
  buildWorkbenchThreadRecallInstructions,
  buildWorkbenchThreadResumeInstructions,
} from "../mechanics/workbench-instruction-mechanics.ts";
import { buildThreadTitleInstructions } from "../mechanics/workbench-thread-title-instructions.ts";

test("managed top-level threads expose current-thread mechanics before and after materialization", () => {
  for (const threadId of ["new", "draft:123", "thread-1"]) {
    const context = { harness: "codex" as const, threadId, workbenchOrigin: "http://localhost" };
    const available = listWorkbenchInstructionMechanics(context);
    for (const mechanic of ["thread-title", "thread-status", "thread-git", "thread-recall", "thread-resume"]) {
      assert.equal(available.has(mechanic), true, `${threadId} should expose ${mechanic}`);
    }
    assert.match(buildThreadTitleInstructions(context) ?? "", /mcp__wb__thread_title/u);
    assert.match(buildThreadStatusInstructions(context) ?? "", /mcp__wb__thread_status/u);
    assert.match(buildWorkbenchGitInstructions(context) ?? "", /mcp__wb__git_arc_plan/u);
    assert.match(buildWorkbenchThreadRecallInstructions(context) ?? "", /mcp__wb__thread_recall/u);
    assert.match(buildWorkbenchThreadResumeInstructions(context) ?? "", /mcp__wb__thread_resume/u);
  }

  const subagentContext = { harness: "codex" as const, subagentName: "Akari", threadId: "draft:child", workbenchOrigin: "http://localhost" };
  const subagent = listWorkbenchInstructionMechanics(subagentContext);
  assert.equal(subagent.has("thread-title"), false);
  assert.equal(subagent.has("thread-status"), true);
  assert.equal(subagent.has("thread-git"), true);
  assert.equal(subagent.has("thread-recall"), true);
  assert.equal(subagent.has("thread-resume"), true);
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
  assert.match(filtered ?? "", /mcp__wb__thread_status/u);
  assert.doesNotMatch(filtered ?? "", /<\/?available:/u);
  assert.deepEqual(warnings, []);
});

test("Workbench instruction sources prefer typed MCP tools with one exact CLI fallback", async () => {
  const context = { harness: "codex" as const, threadId: "thread-1", workbenchOrigin: "http://localhost" };
  const fallback = "The wb mcp commands are also available through the wb cli. use `wb --help` if the wb mcp commands are not available.";
  const sources = [
    readInstructionSource("injections/workbench-tools-injection.md"),
    readInstructionSource("base/workbench-agents-prompt.md"),
    readInstructionSource("workflows/default-workflow-prompt.md"),
    readInstructionSource("workflows/subagent-workflow-prompt.md"),
    readInstructionSource("skills/browse-builtin-skill.md"),
    buildWorkbenchGitInstructions(context) ?? "",
    buildWorkbenchOrchestratorReloadInstructions(context) ?? "",
    buildWorkbenchSubagentInstructions(context) ?? "",
    buildWorkbenchThreadRecallInstructions(context) ?? "",
    buildWorkbenchThreadResumeInstructions(context) ?? "",
    buildThreadStatusInstructions(context) ?? "",
    buildThreadTitleInstructions(context) ?? "",
    await buildWorkbenchBrowseInstructions(context) ?? "",
  ];
  const commandShapedCliLines = sources
    .flatMap((source) => source.split(/\r?\n/u))
    .filter((line) => /(?:`wb(?:\.cmd)?\s|^\s*wb(?:\.cmd)?\s)/u.test(line));

  assert.deepEqual(commandShapedCliLines, [fallback]);
  assert.match(sources.join("\n"), /mcp__wb__orchestrator_reload/u);
  assert.match(sources.join("\n"), /mcp__wb__subagent_message/u);
  assert.match(sources.join("\n"), /mcp__wb__browse_run/u);
});

test("Workbench rendering instructions document inline plan alert markers and their tone map", () => {
  const rendering = readInstructionSource("injections/workbench-rendering-injection.md");

  assert.match(rendering, /<icon type="alert" color="red\|blue\|green\|purple\|yellow" \/>/u);
  assert.match(rendering, /`blue` uses Tailwind `sky` for new or newly revised content worth noticing/u);
  assert.match(rendering, /`green` uses Tailwind `emerald` for a positive outcome/u);
  assert.match(rendering, /`purple` uses Tailwind `violet` for a consideration/u);
  assert.match(rendering, /`yellow` uses Tailwind `amber` for something that needs attention/u);
  assert.match(rendering, /`red` uses Tailwind `red` for a serious problem/u);
});
