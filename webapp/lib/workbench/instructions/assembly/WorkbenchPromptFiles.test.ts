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
import { WORKBENCH_AGENTS_PROMPT, WORKBENCH_WORKFLOW_DEFAULT_PROMPT } from "./workbench-prompt-sources.ts";
import {
  buildThreadStatusInstructions,
  buildWorkbenchBrowseInstructions,
  buildWorkbenchThreadRecallInstructions,
} from "../mechanics/workbench-instruction-mechanics.ts";
import { buildThreadTitleInstructions } from "../mechanics/workbench-thread-title-instructions.ts";
import { readWorkbenchBuiltinSkills } from "../skills/workbench-builtin-skills.ts";

test("Browse stays explicitly opt-in instead of following UI work", async () => {
  const builtinSkill = readWorkbenchBuiltinSkills().find((skill) => skill.name === "browse");
  const mechanics = await buildWorkbenchBrowseInstructions({ workbenchOrigin: "http://localhost" });
  assert(builtinSkill);
  assert(mechanics);

  assert.match(WORKBENCH_AGENTS_PROMPT, /Browser work is opt-in/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /Do not use, suggest, offer, or ask for Browse/u);
  assert.match(builtinSkill.content, /Use only when .* explicitly calls for browser testing/u);
  assert.match(builtinSkill.content, /UI\/frontend work alone does not activate it/u);
  assert.doesNotMatch(builtinSkill.content, /when a task needs browser testing/iu);
  assert.match(mechanics, /Availability does not activate or authorize Browse/u);
});

test("agent-facing Markdown uses generic user terms", () => {
  const required = [
    "Do not use the user's personal name in agent-facing Markdown.",
    "Use `the user`, even when you know the name.",
    "If project or user guidance defines another generic role term, use that term instead.",
  ];
  assert.deepEqual(required.filter((fragment) => !WORKBENCH_AGENTS_PROMPT.includes(fragment)), []);
});

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

test("harmless planned-path drift keeps the existing approval", () => {
  const instructions = buildWorkbenchGitInstructions({
    harness: "codex",
    threadId: "thread-1",
    workbenchOrigin: "http://localhost",
  }) ?? "";

  assert.match(WORKBENCH_AGENTS_PROMPT, /Workspace, snapshot, or ref drift alone does not invalidate approval/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /approved edit set/u);
  assert.match(WORKBENCH_AGENTS_PROMPT, /Do not restate the plan or ask again only to refresh plan or arc state/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /Drift alone does not invalidate approval/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /approved edit set/u);
  assert.match(WORKBENCH_WORKFLOW_DEFAULT_PROMPT, /Do not repeat Brief or Decision/u);
  assert.match(instructions, /Snapshot drift alone does not invalidate approval/u);
  assert.match(instructions, /Do not return through Brief or ask for approval only because the snapshot or ref changed/u);
  for (const prompt of [WORKBENCH_AGENTS_PROMPT, WORKBENCH_WORKFLOW_DEFAULT_PROMPT, instructions]) {
    assert.match(prompt, /wb git arc plan start -m <intent>/u);
    assert.match(prompt, /Return to Brief only (?:if|when) the plan changed|If the plan changed/u);
  }
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

test("Review instructions choose compare or diff without redundant inspection", () => {
  const instructions = buildWorkbenchGitInstructions({ harness: "codex", threadId: "thread-1", workbenchOrigin: "http://localhost" }) ?? "";
  for (const prompt of [WORKBENCH_AGENTS_PROMPT, WORKBENCH_WORKFLOW_DEFAULT_PROMPT, instructions]) {
    assert.match(prompt, /Use .*compare.*when .*paths and counts are enough/iu);
    assert.match(prompt, /Use .*diff.*when .*unified details are already needed/iu);
    assert.match(prompt, /do not run compare first/iu);
    assert.match(prompt, /At least one of compare or diff is required/iu);
  }
});
