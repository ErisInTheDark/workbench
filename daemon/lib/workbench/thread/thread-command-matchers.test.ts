/*
 * Exports:
 * - No production exports; Node tests cover shell command summary matching, typed wb inventory, questionnaire waits, and argument semantics. Keywords: thread, command, matcher, questionnaire, powershell, ripgrep, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "workbench-shared/codex/generated/app-server/serde_json/JsonValue";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import { listWorkbenchAgentCommands } from "../commands/workbench-agent-command-registry.ts";
import { getWorkbenchAgentCommandToolName } from "../commands/workbench-agent-command-definition.ts";
import type { ThreadCommandDisplayPart } from "../../../../app/workbench/thread/command-matchers/types.ts";
import {
  WORKBENCH_COMMAND_PRESENTATION_NAMES,
  type WorkbenchCommandPresentationName,
} from "../../../../app/workbench/thread/command-matchers/workbench-command-rendering.ts";

import {
  getGitArcMatcherAction,
  getThreadCommandDisplay,
  getThreadCommandExecutionOutcome,
  getThreadCommandOutcomeDisplay,
  getWorkbenchMcpCommandDisplay,
  getWorkbenchMcpCommandRoute,
  getWorkbenchMcpShellCommandItem,
  shouldUseWorkbenchMcpSpecializedRenderer,
  parseGitCheckpointCompareOutput,
  parseGitCheckpointCommitCommand,
  parseGitCheckpointDiffOutput,
  parseGitCheckpointProposalId,
  parseGitArcCommand,
  parseWorkbenchSubagentCommand,
  parseWorkbenchThreadStatusCommand,
  parseWorkbenchThreadTitleCommand,
} from "../../../../app/workbench/thread/thread-command-matchers.ts";

const PROJECT_ROOT = "C:/git/web/workbench";

test("combined scope transcript intent preserves literal MCP paths and CLI operations", () => {
  const cli = parseGitArcCommand("wb git plan claims --inherit -- new.ts -old.ts '*dirty.ts'");
  assert.deepEqual(cli?.paths, ["new.ts"]);
  assert.deepEqual(cli?.removePaths, ["old.ts"]);
  assert.deepEqual(cli?.adoptPaths, ["dirty.ts"]);
  const mcp = getWorkbenchMcpCommandRoute({
    server: "wbex",
    tool: "git_arc_claims",
    argumentsValue: { inherit: true, addPaths: ["-literal.ts"], removePaths: ["old.ts"], adoptPaths: ["dirty.ts"] },
  });
  assert.equal(mcp?.kind, "specialized");
  if (mcp?.kind !== "specialized" || mcp.operation.kind !== "gitArc") assert.fail("Expected Git arc route");
  assert.deepEqual(mcp.operation.operation.paths, ["-literal.ts"]);
  assert.deepEqual(mcp.operation.operation.removePaths, ["old.ts"]);
});

type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

function shellMcpItem(overrides: Partial<McpToolCallItem> = {}): McpToolCallItem {
  return {
    appContext: null,
    arguments: { command: "Get-ChildItem src" },
    durationMs: null,
    error: null,
    id: "shell-one",
    pluginId: null,
    readOnlyHint: false,
    result: null,
    server: "wb",
    status: "inProgress",
    tool: "shell",
    type: "mcpToolCall",
    ...overrides,
  };
}

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
  return parts.flatMap((part) => part.type === "pattern"
    ? [part.pattern]
    : part.type === "text" && part.variant === "code" ? [part.text] : []);
}

function pathOperands(parts: readonly ThreadCommandDisplayPart[]) {
  return parts.flatMap((part) => part.type === "path" ? [part.path] : []);
}

function representativeMcpArguments(name: WorkbenchCommandPresentationName) {
  switch (name) {
    case "toc": return { file: "AGENTS.md" };
    case "rg": return { args: ["-n", "needle", "webapp"] };
    case "tokens": return { text: "count me" };
    case "request_user_input": return { questions: [{ header: "details", id: "details", options: [], question: "What should change?" }] };
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
    default: return {};
  }
}

function workbenchMcpServerForTool(tool: string) {
  const definition = listWorkbenchAgentCommands()
    .find((candidate) => getWorkbenchAgentCommandToolName(candidate) === tool);
  if (!definition) throw new Error(`Unknown Workbench MCP tool: ${tool}`);
  return definition.mcpCodeModeEligible ? "wb" : "wbex";
}

test("every exposed typed wb MCP tool has a semantic route", () => {
  const commands = listWorkbenchAgentCommands();
  const exposedNames = commands
    .filter((definition) => !definition.hideFromMcp)
    .map(getWorkbenchAgentCommandToolName)
    .sort();
  for (const tool of exposedNames) {
    assert.ok((WORKBENCH_COMMAND_PRESENTATION_NAMES as readonly string[]).includes(tool), tool);
    assert.ok(getWorkbenchMcpCommandRoute({
      argumentsValue: representativeMcpArguments(tool as WorkbenchCommandPresentationName),
      server: workbenchMcpServerForTool(tool),
      tool,
    }), tool);
  }
  const wait = commands.find((definition) => definition.words.join("_") === "git_arc_wait");
  assert.deepEqual(wait?.effects, {});
  assert.equal(wait?.mcpRuntimeDrainPolicy, "preserve-across-reload");
  assert.equal(wait?.mcpSteerInterruptible, true);
  const subagentWait = commands.find((definition) => definition.words.join("_") === "subagent_wait");
  assert.equal(subagentWait?.mcpRuntimeDrainPolicy, "preserve-across-reload");
  assert.equal(subagentWait?.mcpSteerInterruptible, true);
  const questionnaire = commands.find((definition) => definition.words.join("_") === "request_user_input");
  assert.deepEqual(questionnaire?.effects, {});
  assert.equal(questionnaire?.mcpCodeModeEligible, true);
  assert.equal(questionnaire?.mcpRuntimeDrainPolicy, "preserve-across-reload");
  assert.equal(questionnaire?.mcpSteerInterruptible, undefined);
  assert.equal(getWorkbenchMcpCommandDisplay({
    argumentsValue: representativeMcpArguments("request_user_input"),
    server: "wb",
    tool: "request_user_input",
  })?.omitFromDisplay, true);
});

test("simple typed wb MCP calls share argument-sensitive CLI presentations", () => {
  const cases = [
    ['wb toc "docs/guide file.md"', "toc", { file: "docs/guide file.md" }],
    ["wb thread refresh", "thread_refresh", {}],
    ["wb tokens -- count-me", "tokens", { text: "count-me" }],
    ["wb tokens instructions", "tokens_instructions", {}],
    ["wb tokens project", "tokens_project", {}],
    ["wb git add -- src/a.ts", "git_add", { paths: ["src/a.ts"] }],
    ["wb thread title get", "thread_title_get", {}],
    ["wb subagent list", "subagent_list", {}],
    ['wb browse run --thread thread-one --session rendering --summary "Check page" --command "snapshot --compact"', "browse_run", { commands: ["snapshot --compact"], session: "rendering", summary: "Check page" }],
  ] satisfies Array<[string, string, JsonValue]>;

  for (const [command, tool, argumentsValue] of cases) {
    const cli = getThreadCommandDisplay({ command, commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT });
    const mcp = getWorkbenchMcpCommandDisplay({
      argumentsValue,
      server: workbenchMcpServerForTool(tool),
      tool,
    });
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
    ["rg", { args: ["-n", "needle", "webapp"] }, ["plain", "pattern", "plain", "path"]],
    ["thread_title_get", {}, ["plain", "primary"]],
    ["thread_refresh", {}, ["plain", "primary"]],
    ["git_add", { paths: ["src/a.ts"] }, ["plain", "primary"]],
    ["git_unstage", { paths: ["src/a.ts"] }, ["plain", "primary"]],
    ["git_commit", { description: "Details", title: "Commit" }, ["plain", "primary"]],
    ["subagent_list", {}, ["plain", "primary"]],
    ["subagent_profiles", {}, ["plain", "primary"]],
    ["browse_run", { commands: ["snapshot --compact"] }, ["plain", "primary"]],
    ["browse_sessions", {}, ["plain", "primary"]],
    ["browse_stop", { session: "rendering" }, ["plain", "primary", "plain", "code"]],
    ["browse_forget", { session: "rendering" }, ["plain", "primary", "plain", "code"]],
  ] satisfies Array<[string, JsonValue, string[]]>;

  for (const [tool, argumentsValue, expectedKinds] of cases) {
    const display = getWorkbenchMcpCommandDisplay({
      argumentsValue,
      server: workbenchMcpServerForTool(tool),
      tool,
    });
    assert.ok(display, tool);
    assert.deepEqual(displayPartKinds(display.summaryParts), expectedKinds, tool);
    assert.deepEqual(displayPartKinds(display.ongoingSummaryParts), expectedKinds, tool);
  }
});

test("hidden reload commands keep their raw operands out of thread rendering", () => {
  const reload = getThreadCommandDisplay({
    command: "wb reload --server:core+mcp",
    commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT,
  });
  assert.equal(reload.claimedBy, "workbench-cli.reload");
  assert.deepEqual(codeOperands(reload.summaryParts), []);
  const dirt = getThreadCommandDisplay({
    command: "wb dirt",
    commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT,
  });
  assert.equal(dirt.claimedBy, "workbench-cli.dirt");
  assert.deepEqual(codeOperands(dirt.summaryParts), []);
  assert.equal(getThreadCommandDisplay({
    command: "wb orchestrator reload --server:mcp",
    commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT,
  }).claimedBy, null);
});

test("reload help remains a read-only command instead of rendering reload activity", () => {
  for (const command of [
    "wb reload --help",
    '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command \'wb reload --help\'',
  ]) {
    assert.notEqual(getThreadCommandDisplay({
      command,
      commandActions: [],
      cwd: PROJECT_ROOT,
      projectRootPath: PROJECT_ROOT,
    }).claimedBy, "workbench-cli.reload");
  }
});

test("specialized typed wb MCP calls share CLI claims without duplicate summaries", () => {
  const cases = [
    ["wb thread status --status blocked", "thread_status", { status: "blocked" }],
    ['wb thread title --title "Render typed wb tools"', "thread_title", { title: "Render typed wb tools" }],
    ["wb subagent wait --name Lumi --name Nova", "subagent_wait", { names: ["Lumi", "Nova"] }],
    ['wb subagent message --parent --message "progress"', "subagent_message", { message: "progress", parent: true }],
    ["wb git arc wait", "git_arc_wait", {}],
    ["wb git arc mv --regex ^src --replace test -- src", "git_arc_mv", { move: { confirm: false, kind: "regex", pattern: "^src", replacement: "test", roots: ["src"] } }],
    ["wb git arc release --disown", "git_arc_release", { disown: true }],
    ["wb git arc compare", "git_arc_compare", { paths: [] }],
    ["wb thread recall", "thread_recall", {}],
  ] satisfies Array<[string, string, JsonValue]>;

  for (const [command, tool, argumentsValue] of cases) {
    const cli = getThreadCommandDisplay({ command, commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT });
    const route = getWorkbenchMcpCommandRoute({
      argumentsValue,
      server: workbenchMcpServerForTool(tool),
      tool,
    });
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
  assert.equal(getWorkbenchMcpCommandDisplay({ argumentsValue: {}, server: "wbex", tool: "future_command" }), null);
  assert.equal(getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "other", tool: "git_arc_compare" }), null);
  assert.equal(getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "wb", tool: "future_command" }), null);
  assert.equal(getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "wbex", tool: "future_command" }), null);
});

test("wb shell MCP evidence derives ordinary command execution presentation", () => {
  const running = getWorkbenchMcpShellCommandItem(shellMcpItem(), PROJECT_ROOT);
  assert.ok(running);
  assert.equal(running.type, "commandExecution");
  assert.equal(running.command, "Get-ChildItem src");
  assert.equal(running.cwd, PROJECT_ROOT);
  assert.equal(running.shell, "pwsh");
  assert.equal(running.status, "inProgress");
  assert.equal(running.exitCode, null);
  const runningDisplay = getThreadCommandDisplay({
    command: running.command,
    commandActions: running.commandActions,
    cwd: running.cwd,
    projectRootPath: PROJECT_ROOT,
    shell: running.shell,
  });
  assert.equal(runningDisplay.claimedBy, "powershell.list-files");
  assert.equal(runningDisplay.summaryStats.listedFiles, 1);
  assert.deepEqual(pathOperands(runningDisplay.summaryParts), ["src"]);
  assert.ok(getWorkbenchMcpShellCommandItem(shellMcpItem({ server: "wbex" }), PROJECT_ROOT));
  assert.equal(getWorkbenchMcpShellCommandItem(shellMcpItem({ server: "other" }), PROJECT_ROOT), null);

  const completed = getWorkbenchMcpShellCommandItem(shellMcpItem({
    durationMs: 42,
    result: {
      _meta: null,
      content: [{ type: "text", text: "Exit code: 5" }],
      structuredContent: {
        cwd: "C:/git/web/workbench/child",
        exitCode: 5,
        shell: "pwsh",
        stderr: "denied\n",
        stdout: "partial\n",
      },
    },
    status: "completed",
  }), PROJECT_ROOT);
  assert.ok(completed);
  assert.equal(completed.cwd, "C:/git/web/workbench/child");
  assert.equal(completed.exitCode, 5);
  assert.equal(completed.shell, "pwsh");
  assert.equal(completed.aggregatedOutput, "partial\ndenied\n");
  assert.equal(completed.durationMs, 42);

  const failed = getWorkbenchMcpShellCommandItem(shellMcpItem({
    error: { message: "Sandbox launcher failed." },
    status: "failed",
  }), PROJECT_ROOT);
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.aggregatedOutput, "Sandbox launcher failed.");

  assert.equal(getWorkbenchMcpShellCommandItem(shellMcpItem({
    result: {
      _meta: null,
      content: [{ type: "text", text: "malformed" }],
      structuredContent: { exitCode: 0 },
    },
    status: "completed",
  }), PROJECT_ROOT), null);
});

test("explicit shell launchers override command display hints", () => {
  const display = getThreadCommandDisplay({
    command: "bash -lc 'find src -type f'",
    commandActions: [],
    cwd: PROJECT_ROOT,
    shell: "pwsh",
  });

  assert.equal(display.shell, "bash");
});

test("failed Recall MCP calls use the generic error renderer", () => {
  const recallRoute = getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "wb", tool: "thread_recall" });
  const gitRoute = getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "wb", tool: "git_arc_compare" });
  const waitRoute = getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "wbex", tool: "git_arc_wait" });

  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(recallRoute, false), true);
  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(recallRoute, true), false);
  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(gitRoute, true), true);
  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(waitRoute, true), true);
  const statusRoute = getWorkbenchMcpCommandRoute({ argumentsValue: { status: "blocked" }, server: "wbex", tool: "thread_status" });
  const subagentRoute = getWorkbenchMcpCommandRoute({ argumentsValue: { message: "progress", parent: true }, server: "wbex", tool: "subagent_message" });
  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(statusRoute, true), false);
  assert.equal(shouldUseWorkbenchMcpSpecializedRenderer(subagentRoute, true), false);
});

test("PowerShell ripgrep summaries do not treat an uppercase context value as the query", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'rg -n -C 8 "rotate|selectedHarness|onHarness|HarnessIcon|harness" app/components/workbench.tsx | Select-Object -First 180'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.search-rg,powershell.select-object-limit");
  assert.deepEqual(codeOperands(display.summaryParts), ["rotate|selectedHarness|onHarness|HarnessIcon|harness"]);
  assert.deepEqual(pathOperands(display.summaryParts), ["app/components/workbench.tsx"]);
  assert.equal(display.summaryStats.searchedFiles, 1);
});

test("PowerShell ripgrep summaries preserve lowercase count flags as non-consuming", () => {
  const display = getThreadCommandDisplay({
    command: "pwsh -Command 'rg -n -c needle app/components/workbench.tsx'",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.search-rg");
  assert.deepEqual(codeOperands(display.summaryParts), ["needle"]);
  assert.deepEqual(pathOperands(display.summaryParts), ["app/components/workbench.tsx"]);
});

test("typed ripgrep summaries exactly match the shell ripgrep presentation", () => {
  const cases = [
    {
      args: ["-n", "-C", "3", "needle|thread", "app/components/workbench.tsx"],
      command: String.raw`pwsh -Command 'rg -n -C 3 "needle|thread" app/components/workbench.tsx'`,
    },
    {
      args: ["-n", "-e", String.raw`needle\(thread`, "webapp/orchestrator"],
      command: String.raw`pwsh -Command 'rg -n -e "needle\(thread" webapp/orchestrator'`,
    },
    {
      args: ["-n", "-g", "*.ts", "needle", "app/workbench"],
      command: String.raw`pwsh -Command 'rg -n -g "*.ts" needle app/workbench'`,
    },
    {
      args: ["needle"],
      command: String.raw`pwsh -Command 'rg needle'`,
    },
    {
      args: ["-F", "needle|thread", "webapp"],
      command: String.raw`pwsh -Command 'rg -F "needle|thread" webapp'`,
    },
  ];

  for (const { args, command } of cases) {
    const shell = getThreadCommandDisplay({
      command,
      commandActions: [],
      cwd: PROJECT_ROOT,
      projectRootPath: PROJECT_ROOT,
    });
    const mcp = getWorkbenchMcpCommandDisplay({
      argumentsValue: { args },
      context: { cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT },
      server: "wb",
      tool: "rg",
    });
    assert.ok(mcp, command);
    assert.deepEqual(mcp.summaryParts, shell.summaryParts, command);
    assert.deepEqual(mcp.ongoingSummaryParts, shell.ongoingSummaryParts, command);
    assert.deepEqual(mcp.summaryStats, shell.summaryStats, command);
  }
});

test("typed ripgrep file listings expose their precise target path", () => {
  const target = "C:/git/web/workbench/.workbench/worktrees/convex-lab/webapp/convex";
  const display = getWorkbenchMcpCommandDisplay({
    argumentsValue: { args: ["--files", target, ""] },
    context: { cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT },
    server: "wb",
    tool: "rg",
  });

  assert.ok(display);
  assert.deepEqual(displayPartKinds(display.summaryParts), ["plain", "plain", "path"]);
  assert.deepEqual(displayPartKinds(display.ongoingSummaryParts), ["plain", "plain", "path"]);
  assert.deepEqual(pathOperands(display.summaryParts), [".workbench/worktrees/convex-lab/webapp/convex"]);
  assert.deepEqual(codeOperands(display.summaryParts), []);
  assert.equal(display.summaryStats.searchedFiles, 1);
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
    command: 'wb git commit --worktree C:/workspace/.worktrees/lab --title "A bounded commit"',
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
    command: "wb git plan claims -m Update -- src/file.ts",
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
    command: "wb git arc claims --inherit -- src/new.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(addition, "git-arc.claims");

  const adoption = getThreadCommandDisplay({
    command: "wb git arc claims --inherit -- '*src/dirty.ts'",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(adoption, "git-arc.claims");

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
    command: "wb git arc claims --inherit -- -src/old.ts",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(removal, "git-arc.claims");

  const release = getThreadCommandDisplay({
    command: "wb git arc release --disown",
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assertRouteOnlyDisplay(release, "git-arc.release");
  assert.deepEqual(parseGitArcCommand("wb git arc release --disown"), {
    action: "release",
    disown: true,
    intentName: null,
    paths: [],
    ref: null,
  });

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
    command: "wb git arc propose --title Title -- src/file.ts",
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
    'wb git arc propose --title "Polish checkpoint cards" --description "Keep quoted context useful." -- src/one.ts "src/two words.ts"',
  ), {
    amend: false,
    description: "Keep quoted context useful.",
    paths: ["src/one.ts", "src/two words.ts"],
    title: "Polish checkpoint cards",
  });
  assert.deepEqual(parseGitCheckpointCommitCommand(
    "wb git arc propose --root web --title Title -- src/client.ts",
  ), {
    amend: false,
    description: "",
    paths: ["src/client.ts"],
    rootId: "web",
    title: "Title",
  });
  assert.deepEqual(parseGitCheckpointCommitCommand(
    'wb git arc propose --amend --title "Amend title" --description "Amend description" --fresh-title "Fresh title" --fresh-description "Fresh description" -- src/client.ts',
  ), {
    amend: true,
    description: "Amend description",
    freshDescription: "Fresh description",
    freshTitle: "Fresh title",
    paths: ["src/client.ts"],
    title: "Amend title",
  });
  assert.deepEqual(parseGitCheckpointCommitCommand(
    'wb git arc propose --amend proposal-one --title "Legacy amend title"',
  ), {
    amend: true,
    description: "",
    paths: [],
    title: "Legacy amend title",
  });
  assert.equal(parseGitCheckpointCommitCommand("wb git arc propose -- src/one.ts"), null);
  assert.equal(parseGitCheckpointCommitCommand("wb git checkpoint commit --sha abc --m Title -- src/one.ts"), null);
});

test("Git arc diff parsing excludes the human inspection trailer", () => {
  const changes = parseGitCheckpointDiffOutput([
    "diff --git a/src/file.ts b/src/file.ts",
    "--- a/src/file.ts",
    "+++ b/src/file.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "Workbench arc diff notes:",
    "Unclaimed workspace dirt modified since this thread was created:",
    "- src/unclaimed.ts",
    "More diff files remain. Repeat this command with `--page 2`.",
  ].join("\n"));

  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.path, "src/file.ts");
  assert.doesNotMatch(changes[0]?.diff ?? "", /Unclaimed workspace dirt|--page 2/u);
});

test("current-plan and proposal-lifecycle commands expose route-only matcher claims", () => {
  const cases = [
    ["wb git plan claims --inherit -- src/a.ts", "git-arc.plan"],
    ["wb git plan claims --inherit -- -src/a.ts", "git-arc.plan"],
    ["wb git plan claims --inherit -- '*src/dirty.ts'", "git-arc.plan"],
    ["wb git plan start -m Continue -- src/a.ts", "git-arc.plan-start"],
    ["wb git arc rescind --proposal proposal-one", "git-arc.rescind"],
  ] as const;
  for (const [command, claimedBy] of cases) {
    const display = getThreadCommandDisplay({ command, commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT });
    assertRouteOnlyDisplay(display, claimedBy);
  }

  assert.deepEqual(parseGitArcCommand("wb git plan claims --inherit -- src/a.ts -src/old.ts '*src/dirty.ts'"), {
    action: "plan", intentName: null, paths: ["src/a.ts"], removePaths: ["src/old.ts"], adoptPaths: ["src/dirty.ts"], ref: null,
  });
  assert.deepEqual(parseGitArcCommand("wb git plan start --inherit"), {
    action: "planStart", intentName: null, paths: [], removePaths: [], adoptPaths: [], ref: null,
  });
  assert.deepEqual(parseGitArcCommand("wb git arc rescind --proposal proposal-one"), {
    action: "rescind", intentName: null, paths: [], proposalId: "proposal-one", ref: null,
  });
  assert.equal(getGitArcMatcherAction("powershell,git-arc.plan"), "plan");

  const wrappedPlanRemove = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'wb git plan claims --inherit -- -src/a.ts'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });
  assert.equal(wrappedPlanRemove.claimedBy, "git-arc.plan");
  assert.equal(getGitArcMatcherAction(wrappedPlanRemove.claimedBy), "plan");
});

test("unrecognised Git arc requests retain a bounded presentation without invented intent", () => {
  for (const [command, tool] of [
    ["wb git arc unrecognised -- src/a.ts", "git_arc_unrecognised"],
    ["wb git plan unrecognised -- src/a.ts", "git_plan_unrecognised"],
  ]) {
    const display = getThreadCommandDisplay({ command, commandActions: [], cwd: PROJECT_ROOT, projectRootPath: PROJECT_ROOT });
    assert.equal(getGitArcMatcherAction(display.claimedBy), "unknown");
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: { paths: ["src/a.ts"] }, server: "wb", tool });
    assert.equal(route?.kind, "specialized");
    if (route?.kind !== "specialized" || route.operation.kind !== "gitArc") throw new Error("Expected Git arc presentation.");
    assert.equal(route.operation.operation.action, "unknown");
    assert.deepEqual(route.operation.operation.paths, []);
  }
  assert.equal(getWorkbenchMcpCommandRoute({ argumentsValue: {}, server: "other", tool: "git_arc_unrecognised" }), null);
});

test("PowerShell-wrapped arc proposals preserve escaped titles, descriptions, and apostrophes", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "wb git arc propose --title \"Group thread context menu controls\" --description \"Add grouped controls and preserve Chiri's lifecycle status.\""`,
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
wb git arc propose --replace proposal-one --title \"make arc Git transactions consistent\" --description $description"`,
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
wb git arc propose --title \"dynamic proposal\" --description $description"`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, null);
  assert.equal(display.summaryKind, "raw");
});

test("PowerShell numbered reads resolve a preceding literal path assignment", () => {
  const display = getThreadCommandDisplay({
    command: String.raw`"c:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '$p='"'"'app\\workbench\\thread\\command-matchers\\workbench-cli.ts'"'"'; $c=Get-Content $p; $c[80..116]'`,
    commandActions: [],
    cwd: PROJECT_ROOT,
    projectRootPath: PROJECT_ROOT,
  });

  assert.equal(display.claimedBy, "powershell.hide-trivial-assignment,powershell.read-numbered-lines");
  assert.deepEqual(pathOperands(display.summaryParts), [
    "app/workbench/thread/command-matchers/workbench-cli.ts",
  ]);
  assert.deepEqual(pathOperands(display.ongoingSummaryParts), [
    "app/workbench/thread/command-matchers/workbench-cli.ts",
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
