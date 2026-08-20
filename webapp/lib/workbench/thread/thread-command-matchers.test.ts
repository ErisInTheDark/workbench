/*
 * Exports:
 * - No production exports; Node tests cover shell command summary matching and argument semantics. Keywords: thread, command, matcher, powershell, ripgrep, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getThreadCommandDisplay,
  getThreadCommandExecutionOutcome,
  getThreadCommandOutcomeDisplay,
  parseGitCheckpointCompareOutput,
  parseGitCheckpointCommitCommand,
  parseGitCheckpointProposalId,
  parseGitArcCommand,
  parseWorkbenchSubagentCommand,
  parseWorkbenchThreadTitleCommand,
} from "./thread-command-matchers.ts";

const PROJECT_ROOT = "C:/git/web/workbench";

test("PowerShell ripgrep summaries do not treat an uppercase context value as the query", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'rg -n -C 8 "rotate|selectedHarness|onHarness|HarnessIcon|harness" webapp/components/workbench.tsx | Select-Object -First 180'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.search-rg,powershell.select-object-limit");
  assert.equal(
    display.summaryText,
    'Search for "rotate|selectedHarness|onHarness|HarnessIcon|harness" in webapp/components/workbench.tsx -> Take first 180',
  );
  assert.equal(
    display.ongoingSummaryText,
    'Searching for "rotate|selectedHarness|onHarness|HarnessIcon|harness" in webapp/components/workbench.tsx -> Taking first 180',
  );
});

test("PowerShell ripgrep summaries preserve lowercase count flags as non-consuming", () => {
  const display = getThreadCommandDisplay({
    command: "pwsh -Command 'rg -n -c needle webapp/components/workbench.tsx'",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.search-rg");
  assert.equal(display.summaryText, 'Search for "needle" in webapp/components/workbench.tsx');
  assert.equal(display.ongoingSummaryText, 'Searching for "needle" in webapp/components/workbench.tsx');
});

test("Workbench subagent commands share one semantic parser", () => {
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent wait --id child-thread"), {
    action: "wait",
    message: null,
    name: null,
    profileId: null,
    threadIds: ["child-thread"],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand('wb.cmd subagent message --id "child thread" --message continue'), {
    action: "message",
    message: "continue",
    name: null,
    profileId: null,
    threadIds: ["child thread"],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent stop --id='child-thread'"), {
    action: "stop",
    message: null,
    name: null,
    profileId: null,
    threadIds: ["child-thread"],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent wait --id child-thread; Write-Output done"), {
    action: "wait",
    message: null,
    name: null,
    profileId: null,
    threadIds: ["child-thread"],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand('wb subagent message --message "Use the safer `route`" --id child-thread'), {
    action: "message",
    message: "Use the safer `route`",
    name: null,
    profileId: null,
    threadIds: ["child-thread"],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent profiles"), {
    action: "profiles",
    message: null,
    name: null,
    profileId: null,
    threadIds: [],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand('wb subagent message --parent --message "Progress note"'), {
    action: "message",
    message: "Progress note",
    name: null,
    profileId: null,
    threadIds: [],
    title: null,
    toParent: true,
  });
  assert.equal(parseWorkbenchSubagentCommand("wb thread recall --thread child-thread"), null);

  const display = getThreadCommandDisplay({
    command: "wb subagent wait --id child-thread",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(display.claimedBy, "workbench-cli.subagent");
  assert.equal(display.summaryText, "Waited for subagent");
  assert.equal(display.ongoingSummaryText, "Waiting for subagent");

  const multiplexedDisplay = getThreadCommandDisplay({
    command: "wb subagent wait --id child-thread --id other-child",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(multiplexedDisplay.claimedBy, "workbench-cli.subagent");
  assert.equal(multiplexedDisplay.summaryText, "Waited for 2 subagents");
  assert.equal(multiplexedDisplay.ongoingSummaryText, "Waiting for 2 subagents");

  const parentMessageDisplay = getThreadCommandDisplay({
    command: 'wb subagent message --parent --message "Progress note"',
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(parentMessageDisplay.summaryText, "Messaged parent");
  assert.equal(parentMessageDisplay.ongoingSummaryText, "Messaging parent");

});

test("Workbench thread title commands distinguish standalone sets from grouped reads", () => {
  assert.deepEqual(parseWorkbenchThreadTitleCommand('wb thread title --title "Trace cache invalidation"'), {
    action: "set",
    title: "Trace cache invalidation",
  });
  assert.deepEqual(parseWorkbenchThreadTitleCommand("wb thread title get"), { action: "get" });

  const titleSet = getThreadCommandDisplay({
    command: 'wb thread title --title "Trace cache invalidation"',
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(titleSet.claimedBy, "workbench-cli.thread-title-set");
  assert.equal(titleSet.omitFromDisplay, false);
  assert.equal(titleSet.summaryText, "Task: Trace cache invalidation");

  const titleGet = getThreadCommandDisplay({
    command: "wb thread title get",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(titleGet.claimedBy, "workbench-cli.thread-title-get");
  assert.equal(titleGet.summaryText, "Checked thread title");
  assert.equal(titleGet.ongoingSummaryText, "Checking thread title");
});

test("Workbench subagent create commands expose metadata through PowerShell wrappers", () => {
  const createCommand = 'wb subagent create --profile "safety-profile" --name Maribel --title "Review bridge reloads" --message "Check cancellation and pending waiters"';
  assert.deepEqual(parseWorkbenchSubagentCommand(createCommand), {
    action: "create",
    message: "Check cancellation and pending waiters",
    name: "Maribel",
    profileId: "safety-profile",
    threadIds: [],
    title: "Review bridge reloads",
    toParent: false,
  });
  const wrappedCreateDisplay = getThreadCommandDisplay({
    command: `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '${createCommand}'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(wrappedCreateDisplay.claimedBy, "workbench-cli.subagent");
  assert.equal(wrappedCreateDisplay.summaryText, "Created subagent");
  assert.equal(wrappedCreateDisplay.ongoingSummaryText, "Creating subagent");
});

test("Workbench subagent commands prefer clean semantic actions over escaped PowerShell wrappers", () => {
  const semanticCommand = 'wb subagent create --profile 48444e25-57b2-474b-80de-f842bb511762 --name Nell --title "Book 1 chapters 60 through 84 note pass" --message "# Read the notes\n\n- Preserve **Markdown**\n- Keep `C:\\stories\\book.md` linked"';
  const wrappedCommand = String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "wb subagent create --profile 48444e25-57b2-474b-80de-f842bb511762 --name Nell --title \"Book 1 chapters 60 through 84 note pass\" --message \"# Read the notes...\""`;

  assert.deepEqual(parseWorkbenchSubagentCommand(wrappedCommand, [
    { type: "unknown", command: "Get-Location" },
    { type: "unknown", command: semanticCommand },
  ]), {
    action: "create",
    message: "# Read the notes\n\n- Preserve **Markdown**\n- Keep `C:\\stories\\book.md` linked",
    name: "Nell",
    profileId: "48444e25-57b2-474b-80de-f842bb511762",
    threadIds: [],
    title: "Book 1 chapters 60 through 84 note pass",
    toParent: false,
  });
});

test("Workbench subagent list gets dedicated metadata labels", () => {
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent list --limit 20"), {
    action: "list",
    message: null,
    name: null,
    profileId: null,
    threadIds: [],
    title: null,
    toParent: false,
  });
  const listDisplay = getThreadCommandDisplay({
    command: "wb subagent list",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(listDisplay.claimedBy, "workbench-cli.subagent");
  assert.equal(listDisplay.summaryText, "Listed subagents");
  assert.equal(listDisplay.ongoingSummaryText, "Listing subagents");
});

test("all Workbench CLI matcher families show the alternate install cwd name", () => {
  const commands = [
    "wb orchestrator reload --orchestrator-logic",
    "wb thread recall --thread thread-id",
    "wb browse sessions --thread thread-id",
    "wb git add --thread thread-id -- file.ts",
    "wb git arc diff --ref abc -- file.ts",
  ];
  for (const command of commands) {
    const display = getThreadCommandDisplay({
      command,
      commandActions: [],
      cwd: "C:/git/web/workbench/.workbench/worktrees/convex-lab",
      projectRootPath: PROJECT_ROOT,
    });
    assert.match(display.summaryText, /^convex-lab: /u, command);
    assert.match(display.ongoingSummaryText, /^convex-lab: /u, command);
  }

  const caseDistinctPosixDisplay = getThreadCommandDisplay({
    command: "wb subagent list",
    commandActions: [],
    cwd: "/workspace/Workbench",
    projectRootPath: "/workspace/workbench",
  });
  assert.match(caseDistinctPosixDisplay.summaryText, /^Workbench: /u);

  const failedDisplay = getThreadCommandOutcomeDisplay(getThreadCommandDisplay({
    command: "wb subagent list",
    commandActions: [],
    cwd: "C:/git/web/workbench/.workbench/worktrees/convex-lab",
    projectRootPath: PROJECT_ROOT,
  }), "failed");
  assert.equal(failedDisplay.summaryText, "convex-lab: Failed listing subagents");
});

test("command execution outcomes select the explicit ongoing tense", () => {
  const display = getThreadCommandDisplay({
    command: "pwsh -Command 'rg needle webapp'",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(getThreadCommandExecutionOutcome("inProgress", null), "inProgress");
  assert.equal(getThreadCommandExecutionOutcome("failed", 124), "timedOut");
  assert.equal(getThreadCommandExecutionOutcome("completed", 124), "timedOut");
  assert.equal(getThreadCommandExecutionOutcome("failed", 1), "failed");
  assert.equal(getThreadCommandExecutionOutcome("declined", null), "declined");
  assert.equal(getThreadCommandExecutionOutcome("completed", 0), "completed");

  assert.equal(getThreadCommandOutcomeDisplay(display, "inProgress").summaryText, 'Searching for "needle" in webapp');
  assert.equal(getThreadCommandOutcomeDisplay(display, "timedOut").summaryText, 'Timed out searching for "needle" in webapp');
  assert.equal(getThreadCommandOutcomeDisplay(display, "failed").summaryText, 'Failed searching for "needle" in webapp');
  assert.equal(getThreadCommandOutcomeDisplay(display, "declined").summaryText, 'Declined searching for "needle" in webapp');
});

test("raw commands receive an explicit ongoing fallback", () => {
  const display = getThreadCommandDisplay({
    command: "mystery-command --flag",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.summaryText, "mystery-command --flag");
  assert.equal(display.ongoingSummaryText, "Running mystery-command --flag");
  assert.equal(getThreadCommandOutcomeDisplay(display, "timedOut").summaryText, "Timed out running mystery-command --flag");
});

test("Workbench Git commands receive bounded selection, commit, plan, and arc summaries", () => {
  const selection = getThreadCommandDisplay({
    command: "wb git add --worktree C:/workspace/.worktrees/lab -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(selection.claimedBy, "workbench-git.selection");
  assert.equal(selection.summaryText, "Selected files for commit");
  assert.equal(selection.ongoingSummaryText, "Selecting files for commit");

  const commit = getThreadCommandDisplay({
    command: 'wb git commit --worktree C:/workspace/.worktrees/lab --message "A bounded commit"',
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(commit.claimedBy, "workbench-git.commit");
  assert.equal(commit.summaryText, "Committed selected files");
  assert.equal(commit.ongoingSummaryText, "Committing selected files");

  const diff = getThreadCommandDisplay({
    command: "wb git arc diff -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(diff.claimedBy, "git-arc.diff");
  assert.equal(diff.summaryText, "Diffed Git arc");

  const plan = getThreadCommandDisplay({
    command: "wb git arc plan -m Update -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(plan.claimedBy, "git-arc.plan");
  assert.equal(plan.summaryText, "Created Git plan");

  const legacyCheckpoint = getThreadCommandDisplay({
    command: "wb git checkpoint plan",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.doesNotMatch(String(legacyCheckpoint.claimedBy), /git-(?:checkpoint|arc|plan)/u);

  const addition = getThreadCommandDisplay({
    command: "wb git arc add -- src/new.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(addition.claimedBy, "git-arc.add");
  assert.equal(addition.summaryText, "Extended Git arc");

  const adoption = getThreadCommandDisplay({
    command: "wb git arc adopt -- src/dirty.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(adoption.claimedBy, "git-arc.adopt");
  assert.equal(adoption.summaryText, "Adopted workspace changes");

  const movePreview = getThreadCommandDisplay({
    command: "wb git arc mv --regex ^src/(.+)$ --replace tests/$1 -- src",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(movePreview.claimedBy, "git-arc.mv");
  assert.equal(movePreview.summaryText, "Previewed Git arc moves");
  assert.equal(movePreview.ongoingSummaryText, "Previewing Git arc moves");

  const moveApplied = getThreadCommandDisplay({
    command: "wb git arc mv src/one.ts tests/src/one.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(moveApplied.claimedBy, "git-arc.mv");
  assert.equal(moveApplied.summaryText, "Moved Git arc paths");
  assert.deepEqual(parseGitArcCommand("wb git arc mv --map src/one.ts tests/one.ts --map src/two.ts tests/two.ts"), {
    action: "mv",
    intentName: null,
    move: {
      kind: "maps",
      mappings: [
        { destination: "tests/one.ts", source: "src/one.ts" },
        { destination: "tests/two.ts", source: "src/two.ts" },
      ],
    },
    paths: ["src/one.ts", "tests/one.ts", "src/two.ts", "tests/two.ts"],
    ref: null,
  });

  const removal = getThreadCommandDisplay({
    command: "wb git arc remove -- src/old.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(removal.claimedBy, "git-arc.remove");
  assert.equal(removal.summaryText, "Reduced Git arc");

  const start = getThreadCommandDisplay({
    command: "wb git arc start --ref abc",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(start.claimedBy, "git-arc.start");
  assert.equal(start.summaryText, "Checked Git arc");

  const compare = getThreadCommandDisplay({
    command: "wb git arc compare -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(compare.claimedBy, "git-arc.compare");
  assert.equal(compare.summaryText, "Compared Git arc");

  const proposal = getThreadCommandDisplay({
    command: "wb git arc propose -m Title -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(proposal.claimedBy, "git-arc.propose");
  assert.equal(proposal.summaryText, "Proposed arc commit");

  assert.deepEqual(parseGitCheckpointCompareOutput([
    "Workbench arc comparison",
    "M\t+4\t-2\tsrc/file.ts",
  ].join("\n")), [{ additions: 4, deletions: 2, path: "src/file.ts", status: "M" }]);
  assert.equal(parseGitCheckpointProposalId("Workbench arc proposal: proposal-one\n"), "proposal-one");
  assert.deepEqual(parseGitCheckpointCommitCommand(
    'wb git arc propose -m "Polish checkpoint cards" -m "Keep quoted context useful." -- src/one.ts "src/two words.ts"',
  ), {
    amend: false,
    description: "Keep quoted context useful.",
    paths: ["src/one.ts", "src/two words.ts"],
    title: "Polish checkpoint cards",
  });
  assert.deepEqual(parseGitCheckpointCommitCommand(
    "wb git arc propose -m Title",
  ), {
    amend: false,
    description: "",
    paths: [],
    title: "Title",
  });
  assert.equal(parseGitCheckpointCommitCommand("wb git arc propose -- src/one.ts"), null);
  assert.equal(parseGitCheckpointCommitCommand("wb git checkpoint commit --sha abc --m Title -- src/one.ts"), null);
});

test("current-plan and proposal-lifecycle commands receive distinct truthful summaries", () => {
  const cases = [
    ["wb git arc plan add -- src/a.ts", "git-arc.plan-add", "Extended Git plan"],
    ["wb git arc plan remove -- src/a.ts", "git-arc.plan-remove", "Reduced Git plan"],
    ["wb git arc plan adopt -- src/dirty.ts", "git-arc.plan-adopt", "Adopted changes into Git plan"],
    ["wb git arc plan start -m Continue -- src/a.ts", "git-arc.plan-start", "Created and started Git plan"],
    ["wb git arc rescind --proposal proposal-one", "git-arc.rescind", "Rescinded arc proposal"],
  ] as const;
  for (const [command, claimedBy, summaryText] of cases) {
    const display = getThreadCommandDisplay({ command, commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT });
    assert.equal(display.claimedBy, claimedBy);
    assert.equal(display.summaryText, summaryText);
  }
});

test("PowerShell-wrapped arc proposals preserve escaped messages and apostrophes", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "wb git arc propose -m \"Group thread context menu controls\" -m \"Add grouped controls and preserve Chiri's lifecycle status.\""`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "git-arc.propose");
  assert.deepEqual(parseGitCheckpointCommitCommand(display.unwrappedCommand), {
    amend: false,
    description: "Add grouped controls and preserve Chiri's lifecycle status.",
    paths: [],
    title: "Group thread context menu controls",
  });
});

test("PowerShell numbered reads resolve a preceding literal path assignment", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"c:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'"'webapp\\lib\\workbench\\thread\\command-matchers\\workbench-cli.ts'"'"'; $c=Get-Content $p; $c[80..116]'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.hide-trivial-assignment,powershell.read-numbered-lines");
  assert.equal(
    display.summaryText,
    "Read lines 81-117 of webapp/lib/workbench/thread/command-matchers/workbench-cli.ts",
  );
  assert.equal(
    display.ongoingSummaryText,
    "Reading lines 81-117 of webapp/lib/workbench/thread/command-matchers/workbench-cli.ts",
  );

  const pathPart = display.summaryParts.at(-1);
  assert.equal(pathPart?.type, "path");
  if (pathPart?.type === "path") {
    assert.equal(pathPart.path, "webapp/lib/workbench/thread/command-matchers/workbench-cli.ts");
  }
});

test("PowerShell numbered reads invalidate a literal path after dynamic reassignment", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"c:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'"'safe.ts'"'"'; $p="$other"; $c=Get-Content $p; $c[0..1]'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(
    display.claimedBy,
    "powershell.hide-trivial-assignment,powershell.hide-trivial-assignment,powershell.read-numbered-lines",
  );
  assert.equal(display.summaryText, "Read lines 1-2 of $p");
  assert.equal(display.ongoingSummaryText, "Reading lines 1-2 of $p");
});
