/*
 * Exports:
 * - No production exports; Node tests cover shell command summary matching and argument semantics. Keywords: thread, command, matcher, powershell, ripgrep, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "../../codex/generated/app-server/serde_json/JsonValue.ts";
import { listWorkbenchAgentCommands } from "../commands/workbench-agent-command-registry.ts";
import { getWorkbenchAgentCommandToolName } from "../commands/workbench-agent-command-definition.ts";
import type { ThreadCommandDisplayPart } from "./command-matchers/types.ts";
import {
  WORKBENCH_COMMAND_PRESENTATION_NAMES,
  type WorkbenchCommandPresentationName,
} from "./command-matchers/workbench-command-rendering.ts";

import {
  getGitArcMatcherAction,
  getThreadCommandDisplay,
  getThreadCommandExecutionOutcome,
  getThreadCommandOutcomeDisplay,
  getWorkbenchMcpCommandDisplay,
  getWorkbenchMcpCommandRoute,
  shouldUseWorkbenchMcpSpecializedRenderer,
  parseGitCheckpointCompareOutput,
  parseGitCheckpointCommitCommand,
  parseGitCheckpointProposalId,
  parseGitArcCommand,
  parseWorkbenchSubagentCommand,
  parseWorkbenchThreadStatusCommand,
  parseWorkbenchThreadTitleCommand,
} from "./thread-command-matchers.ts";

const PROJECT_ROOT = "C:/git/web/workbench";

function assertRouteOnlyDisplay(
  display: ReturnType<typeof getThreadCommandDisplay>,
  claimedBy: string,
) {
  assert.equal(display.claimedBy, claimedBy);
  assert.equal(display.omitFromDisplay, true);
  assert.deepEqual(display.summaryParts, []);
  assert.deepEqual(display.ongoingSummaryParts, []);
}

function displayPartKinds(parts: readonly ThreadCommandDisplayPart[]) {
  return parts.map((part) => part.type === "text" ? part.variant ?? "plain" : part.type);
}

function codeOperands(parts: readonly ThreadCommandDisplayPart[]) {
  return parts.flatMap((part) => part.type === "text" && part.variant === "code" ? [part.text] : []);
}

function pathOperands(parts: readonly ThreadCommandDisplayPart[]) {
  return parts.flatMap((part) => part.type === "path" ? [part.path] : []);
}

function representativeMcpArguments(name: WorkbenchCommandPresentationName) {
  switch (name) {
    case "thread_title": return { title: "Render typed wb tools" };
    case "thread_status": return { status: "completed" };
    case "subagent_wait":
    case "subagent_stop":
    case "subagent_settle": return { names: ["Lumi"] };
    case "subagent_message": return { message: "continue", parent: true };
    case "subagent_create": return { message: "inspect", name: "Lumi", profileId: "profile", title: "Inspect" };
    case "git_arc_mv": return { move: { confirm: false, kind: "regex", pattern: "^src", replacement: "test", roots: ["src"] } };
    case "browse_run": return { commands: ["snapshot --compact"], session: "rendering" };
    case "browse_stop": return { force: true, session: "rendering" };
    case "browse_forget": return { force: false, session: "rendering" };
    case "orchestrator_reload": return { scopes: ["mcp"] };
    default: return {};
  }
}

test("every exposed typed wb MCP tool has a semantic route", () => {
  const exposedNames = listWorkbenchAgentCommands()
    .filter((definition) => !definition.hideFromMcp)
    .map(getWorkbenchAgentCommandToolName)
    .sort();
  const presentationNames = WORKBENCH_COMMAND_PRESENTATION_NAMES
    .filter((name) => name !== "browse_raw")
    .toSorted();
  assert.deepEqual(presentationNames, exposedNames);

  for (const tool of exposedNames) {
    assert.ok(getWorkbenchMcpCommandRoute({
      argumentsValue: representativeMcpArguments(tool as WorkbenchCommandPresentationName),
      server: "wb",
      tool,
    }), tool);
  }
});

test("simple typed wb MCP calls share argument-sensitive CLI presentations", () => {
  const cases = [
    ["wb thread resume", "thread_resume", {}],
    ["wb orchestrator reload --mcp", "orchestrator_reload", { scopes: ["mcp"] }],
    ["wb git add -- src/a.ts", "git_add", { paths: ["src/a.ts"] }],
    ["wb thread title get", "thread_title_get", {}],
    ["wb subagent list", "subagent_list", {}],
    ['wb browse run --thread thread-one --session rendering --summary "Check page" --command "snapshot --compact"', "browse_run", { commands: ["snapshot --compact"], session: "rendering", summary: "Check page" }],
  ] satisfies Array<[string, string, JsonValue]>;

  for (const [command, tool, argumentsValue] of cases) {
    const cli = getThreadCommandDisplay({ command, commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT });
    const mcp = getWorkbenchMcpCommandDisplay({ argumentsValue, server: "wb", tool });
    assert.ok(mcp, tool);
    assert.equal(mcp.claimedBy, cli.claimedBy, tool);
    assert.deepEqual(mcp.summaryParts, cli.summaryParts, tool);
    assert.deepEqual(mcp.ongoingSummaryParts, cli.ongoingSummaryParts, tool);
    assert.deepEqual(mcp.summaryStats, cli.summaryStats, tool);
    assert.deepEqual(getThreadCommandOutcomeDisplay(mcp, "failed").summaryParts, getThreadCommandOutcomeDisplay(cli, "failed").summaryParts, tool);
  }
});

test("every valid simple typed wb MCP route emphasizes its important target", () => {
  const cases = [
    ["thread_title_get", {}, ["plain", "primary"]],
    ["thread_resume", {}, ["plain", "primary"]],
    ["git_add", { paths: ["src/a.ts"] }, ["plain", "primary"]],
    ["git_unstage", { paths: ["src/a.ts"] }, ["plain", "primary"]],
    ["git_commit", { message: "Commit" }, ["plain", "primary"]],
    ["orchestrator_reload", { scopes: ["orchestrator-logic", "mcp"] }, ["plain", "primary"]],
    ["subagent_list", {}, ["plain", "primary"]],
    ["subagent_profiles", {}, ["plain", "primary"]],
    ["browse_run", { commands: ["snapshot --compact"] }, ["plain", "primary"]],
    ["browse_sessions", {}, ["plain", "primary"]],
    ["browse_stop", { session: "rendering" }, ["plain", "primary", "plain", "code"]],
    ["browse_forget", { session: "rendering" }, ["plain", "primary", "plain", "code"]],
  ] satisfies Array<[string, JsonValue, string[]]>;

  for (const [tool, argumentsValue, expectedKinds] of cases) {
    const display = getWorkbenchMcpCommandDisplay({ argumentsValue, server: "wb", tool });
    assert.ok(display, tool);
    assert.deepEqual(displayPartKinds(display.summaryParts), expectedKinds, tool);
    assert.deepEqual(displayPartKinds(display.ongoingSummaryParts), expectedKinds, tool);
  }
});

test("specialized typed wb MCP calls share CLI claims without duplicate summaries", () => {
  const cases = [
    ["wb thread status --status blocked", "thread_status", { status: "blocked" }],
    ['wb thread title --title "Render typed wb tools"', "thread_title", { title: "Render typed wb tools" }],
    ["wb subagent wait --name Lumi --name Nova", "subagent_wait", { names: ["Lumi", "Nova"] }],
    ['wb subagent message --parent --message "progress"', "subagent_message", { message: "progress", parent: true }],
    ["wb git arc mv --regex ^src --replace test -- src", "git_arc_mv", { move: { confirm: false, kind: "regex", pattern: "^src", replacement: "test", roots: ["src"] } }],
    ["wb git arc compare", "git_arc_compare", { paths: [] }],
    ["wb thread recall", "thread_recall", {}],
  ] satisfies Array<[string, string, JsonValue]>;

  for (const [command, tool, argumentsValue] of cases) {
    const cli = getThreadCommandDisplay({ command, commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT });
    const route = getWorkbenchMcpCommandRoute({ argumentsValue, server: "wb", tool });
    assert.equal(route?.kind, "specialized", tool);
    if (!route || route.kind !== "specialized") continue;
    assert.equal(route.rendering.claimedBy, cli.claimedBy, tool);
    assert.deepEqual(route.rendering.result.summaryParts, [], tool);
    assert.equal(route.rendering.result.omitFromDisplay, true, tool);
  }
});

test("non-wb and unknown MCP tools keep generic rendering", () => {
  assert.equal(getWorkbenchMcpCommandDisplay({ argumentsValue: {}, server: "other", tool: "git_arc_compare" }), null);
  assert.equal(getWorkbenchMcpCommandDisplay({ argumentsValue: {}, server: "wb", tool: "future_command" }), null);
  assert.equal(getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "other", tool: "git_arc_compare" }), null);
  assert.equal(getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "wb", tool: "future_command" }), null);
});

test("failed Recall MCP calls use the generic error renderer", () => {
  const recallRoute = getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "wb", tool: "thread_recall" });
  const gitRoute = getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "wb", tool: "git_arc_compare" });

  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(recallRoute, false), true);
  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(recallRoute, true), false);
  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(gitRoute, true), true);
  const statusRoute = getWorkbenchMcpCommandRoute({ argumentsValue: { status: "blocked" }, server: "wb", tool: "thread_status" });
  const subagentRoute = getWorkbenchMcpCommandRoute({ argumentsValue: { message: "progress", parent: true }, server: "wb", tool: "subagent_message" });
  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(statusRoute, true), false);
  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(subagentRoute, true), false);
});

test("PowerShell ripgrep summaries do not treat an uppercase context value as the query", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'rg -n -C 8 "rotate|selectedHarness|onHarness|HarnessIcon|harness" webapp/components/workbench.tsx | Select-Object -First 180'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.search-rg,powershell.select-object-limit");
  assert.deepEqual(codeOperands(display.summaryParts), ['"rotate|selectedHarness|onHarness|HarnessIcon|harness"']);
  assert.deepEqual(pathOperands(display.summaryParts), ["webapp/components/workbench.tsx"]);
  assert.equal(display.summaryStats.searchedFiles, 1);
});

test("PowerShell ripgrep summaries preserve lowercase count flags as non-consuming", () => {
  const display = getThreadCommandDisplay({
    command: "pwsh -Command 'rg -n -c needle webapp/components/workbench.tsx'",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.search-rg");
  assert.deepEqual(codeOperands(display.summaryParts), ['"needle"']);
  assert.deepEqual(pathOperands(display.summaryParts), ["webapp/components/workbench.tsx"]);
});

test("Workbench subagent commands share one semantic parser", () => {
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent wait --id child-thread"), {
    action: "wait",
    message: null,
    name: null,
    profileId: null,
    targets: [{ kind: "id", value: "child-thread" }],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand('wb.cmd subagent message --id "child thread" --message continue'), {
    action: "message",
    message: "continue",
    name: null,
    profileId: null,
    targets: [{ kind: "id", value: "child thread" }],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent stop --id='child-thread'"), {
    action: "stop",
    message: null,
    name: null,
    profileId: null,
    targets: [{ kind: "id", value: "child-thread" }],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent wait --id child-thread; Write-Output done"), {
    action: "wait",
    message: null,
    name: null,
    profileId: null,
    targets: [{ kind: "id", value: "child-thread" }],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand('wb subagent message --message "Use the safer `route`" --id child-thread'), {
    action: "message",
    message: "Use the safer `route`",
    name: null,
    profileId: null,
    targets: [{ kind: "id", value: "child-thread" }],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent profiles"), {
    action: "profiles",
    message: null,
    name: null,
    profileId: null,
    targets: [],
    title: null,
    toParent: false,
  });
  assert.deepEqual(parseWorkbenchSubagentCommand('wb subagent message --parent --message "Progress note"'), {
    action: "message",
    message: "Progress note",
    name: null,
    profileId: null,
    targets: [],
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

  const multiplexedDisplay = getThreadCommandDisplay({
    command: "wb subagent wait --id child-thread --id other-child",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(multiplexedDisplay.claimedBy, "workbench-cli.subagent");

  const parentMessageDisplay = getThreadCommandDisplay({
    command: 'wb subagent message --parent --message "Progress note"',
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(parentMessageDisplay.claimedBy, "workbench-cli.subagent");

});

test("Workbench subagent parser preserves ordered name and id targets", () => {
  assert.deepEqual(
    parseWorkbenchSubagentCommand("wb subagent wait --name Hikari --id child-thread --name Momo"),
    {
      action: "wait",
      message: null,
      name: null,
      profileId: null,
      targets: [
        { kind: "name", value: "Hikari" },
        { kind: "id", value: "child-thread" },
        { kind: "name", value: "Momo" },
      ],
      title: null,
      toParent: false,
    },
  );
  assert.deepEqual(parseWorkbenchSubagentCommand("wb subagent settle --name Hikari --id child-thread"), {
    action: "settle",
    message: null,
    name: null,
    profileId: null,
    targets: [
      { kind: "name", value: "Hikari" },
      { kind: "id", value: "child-thread" },
    ],
    title: null,
    toParent: false,
  });

});

test("Workbench subagent parser preserves valid PowerShell here-string messages", () => {
  const message = "First line\n\n- Preserve **Markdown**\n- Keep `C:\\stories\\book.md` linked";
  for (const [opener, closer] of [["@'", "'@"], ['@"', '"@']] as const) {
    const command = `wb subagent create --profile safety-profile --name Hikari --title "Audit instructions" --message ${opener}\n${message}\n${closer}`;
    assert.deepEqual(parseWorkbenchSubagentCommand(command), {
      action: "create",
      message,
      name: "Hikari",
      profileId: "safety-profile",
      targets: [],
      title: "Audit instructions",
      toParent: false,
    });
  }
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
  assert.equal(titleSet.omitFromDisplay, true);
  assert.deepEqual(titleSet.summaryParts, []);

  const titleGet = getThreadCommandDisplay({
    command: "wb thread title get",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(titleGet.claimedBy, "workbench-cli.thread-title-get");
});

test("Workbench thread status commands match task completion and blocking across command shapes", () => {
  const completed = getThreadCommandDisplay({
    command: "wb thread status --status completed",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(completed.claimedBy, "workbench-cli.thread-status");

  const wrapped = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'wb thread status --status blocked'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(wrapped.claimedBy, "workbench-cli.thread-status");

  assert.deepEqual(parseWorkbenchThreadStatusCommand("escaped wrapper", [
    { type: "unknown", command: "wb thread status --status completed" },
  ]), { status: "completed" });
  assert.equal(parseWorkbenchThreadStatusCommand("wb thread status --status waiting"), null);
});

test("Workbench subagent create commands expose metadata through PowerShell wrappers", () => {
  const createCommand = 'wb subagent create --profile "safety-profile" --name Maribel --title "Review bridge reloads" --message "Check cancellation and pending waiters"';
  assert.deepEqual(parseWorkbenchSubagentCommand(createCommand), {
    action: "create",
    message: "Check cancellation and pending waiters",
    name: "Maribel",
    profileId: "safety-profile",
    targets: [],
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
    targets: [],
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
    targets: [],
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
});

test("command execution outcomes preserve lifecycle semantics", () => {
  assert.equal(getThreadCommandExecutionOutcome("inProgress", null), "inProgress");
  assert.equal(getThreadCommandExecutionOutcome("failed", 124), "timedOut");
  assert.equal(getThreadCommandExecutionOutcome("completed", 124), "timedOut");
  assert.equal(getThreadCommandExecutionOutcome("failed", 1), "failed");
  assert.equal(getThreadCommandExecutionOutcome("declined", null), "declined");
  assert.equal(getThreadCommandExecutionOutcome("completed", 0), "completed");
});

test("raw commands preserve the command operand across lifecycle displays", () => {
  const display = getThreadCommandDisplay({
    command: "mystery-command --flag",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, null);
  assert.equal(display.summaryKind, "raw");
  assert.deepEqual(displayPartKinds(display.summaryParts), ["code"]);
  assert.deepEqual(displayPartKinds(display.ongoingSummaryParts), ["plain", "code"]);
  assert.deepEqual(codeOperands(display.summaryParts), ["mystery-command --flag"]);
  assert.deepEqual(codeOperands(display.ongoingSummaryParts), ["mystery-command --flag"]);
  assert.deepEqual(codeOperands(getThreadCommandOutcomeDisplay(display, "timedOut").summaryParts), ["mystery-command --flag"]);
});

test("Workbench Git commands route to bounded selection, commit, plan, and arc owners", () => {
  const selection = getThreadCommandDisplay({
    command: "wb git add --worktree C:/workspace/.worktrees/lab -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(selection.claimedBy, "workbench-git.selection");

  const commit = getThreadCommandDisplay({
    command: 'wb git commit --worktree C:/workspace/.worktrees/lab --message "A bounded commit"',
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(commit.claimedBy, "workbench-git.commit");

  const diff = getThreadCommandDisplay({
    command: "wb git arc diff -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(diff, "git-arc.diff");

  const plan = getThreadCommandDisplay({
    command: "wb git arc plan -m Update -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(plan, "git-arc.plan");

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
  assertRouteOnlyDisplay(addition, "git-arc.add");

  const adoption = getThreadCommandDisplay({
    command: "wb git arc adopt -- src/dirty.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(adoption, "git-arc.adopt");

  const movePreview = getThreadCommandDisplay({
    command: "wb git arc mv --regex ^src/(.+)$ --replace tests/$1 -- src",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(movePreview, "git-arc.mv");

  const moveApplied = getThreadCommandDisplay({
    command: "wb git arc mv src/one.ts tests/src/one.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(moveApplied, "git-arc.mv");
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
  assertRouteOnlyDisplay(removal, "git-arc.remove");

  const start = getThreadCommandDisplay({
    command: "wb git arc start --ref abc",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(start, "git-arc.start");

  const compare = getThreadCommandDisplay({
    command: "wb git arc compare -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(compare, "git-arc.compare");

  const proposal = getThreadCommandDisplay({
    command: "wb git arc propose -m Title -- src/file.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(proposal, "git-arc.propose");

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

test("current-plan and proposal-lifecycle commands expose route-only matcher claims", () => {
  const cases = [
    ["wb git arc plan add -- src/a.ts", "git-arc.plan-add"],
    ["wb git arc plan remove -- src/a.ts", "git-arc.plan-remove"],
    ["wb git arc plan adopt -- src/dirty.ts", "git-arc.plan-adopt"],
    ["wb git arc plan start -m Continue -- src/a.ts", "git-arc.plan-start"],
    ["wb git arc rescind --proposal proposal-one", "git-arc.rescind"],
  ] as const;
  for (const [command, claimedBy] of cases) {
    const display = getThreadCommandDisplay({ command, commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT });
    assertRouteOnlyDisplay(display, claimedBy);
  }

  assert.deepEqual(parseGitArcCommand("wb git arc plan add -- src/a.ts"), {
    action: "planAdd", intentName: null, paths: ["src/a.ts"], ref: null,
  });
  assert.deepEqual(parseGitArcCommand("wb git arc plan remove -- src/a.ts"), {
    action: "planRemove", intentName: null, paths: ["src/a.ts"], ref: null,
  });
  assert.deepEqual(parseGitArcCommand("wb git arc plan adopt -- src/dirty.ts"), {
    action: "planAdopt", intentName: null, paths: ["src/dirty.ts"], ref: null,
  });
  assert.deepEqual(parseGitArcCommand("wb git arc plan start -m Continue -- src/a.ts"), {
    action: "planStart", intentName: "Continue", paths: ["src/a.ts"], ref: null,
  });
  assert.deepEqual(parseGitArcCommand("wb git arc plan start -m Continue --reload-scope mcp --reload-scope reload-coordinator -- src/a.ts"), {
    action: "planStart", intentName: "Continue", paths: ["src/a.ts"], ref: null, reloadScopes: ["mcp", "reload-coordinator"],
  });
  assert.deepEqual(parseGitArcCommand("wb git arc plan -m Continue --adopt src/dirty-a.ts --adopt src/dirty-b.ts -- src/a.ts"), {
    action: "plan",
    adoptPaths: ["src/dirty-a.ts", "src/dirty-b.ts"],
    intentName: "Continue",
    paths: ["src/a.ts"],
    ref: null,
  });
  assert.deepEqual(parseGitArcCommand("wb git arc rescind --proposal proposal-one"), {
    action: "rescind", intentName: null, paths: [], proposalId: "proposal-one", ref: null,
  });
  assert.equal(getGitArcMatcherAction("powershell,git-arc.plan-remove"), "planRemove");

  const wrappedPlanRemove = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'wb git arc plan remove -- src/a.ts'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(wrappedPlanRemove.claimedBy, "git-arc.plan-remove");
  assert.equal(getGitArcMatcherAction(wrappedPlanRemove.claimedBy), "planRemove");
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

test("PowerShell literal here-string proposal setup renders and preserves Markdown intent", () => {
  const description = [
    "- move thread Git out of Next and serialize worktree mutations",
    "- preserve proposals, claims, and selected index state until publication succeeds",
  ].join("\n");
  const display = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "$description = @'
${description}
'@
wb git arc propose --replace proposal-one -m \"make arc Git transactions consistent\" -m $description"`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(
    display.claimedBy,
    "powershell.hide-literal-here-string-assignment,git-arc.propose",
  );
  assert.equal(display.omitFromDisplay, true);
  assert.deepEqual(display.summaryParts, []);
  assert.deepEqual(display.ongoingSummaryParts, []);
  assert.deepEqual(parseGitCheckpointCommitCommand(display.unwrappedCommand), {
    amend: false,
    description,
    paths: [],
    title: "make arc Git transactions consistent",
  });
});

test("PowerShell interpolated here-string proposal setup remains raw", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "$description = @\"
- include $dynamicValue
\"@
wb git arc propose -m \"dynamic proposal\" -m $description"`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, null);
  assert.equal(display.summaryKind, "raw");
});

test("PowerShell numbered reads resolve a preceding literal path assignment", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"c:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'"'webapp\\lib\\workbench\\thread\\command-matchers\\workbench-cli.ts'"'"'; $c=Get-Content $p; $c[80..116]'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.hide-trivial-assignment,powershell.read-numbered-lines");
  assert.deepEqual(pathOperands(display.summaryParts), [
    "webapp/lib/workbench/thread/command-matchers/workbench-cli.ts",
  ]);
  assert.deepEqual(pathOperands(display.ongoingSummaryParts), [
    "webapp/lib/workbench/thread/command-matchers/workbench-cli.ts",
  ]);
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
  assert.deepEqual(pathOperands(display.summaryParts), ["$p"]);
  assert.deepEqual(pathOperands(display.ongoingSummaryParts), ["$p"]);
});
