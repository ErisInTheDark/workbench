/* No production exports. Tests protect that each transcript tool accepts exactly its action's CLI options, over CLI and MCP alike. */
import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_TRANSCRIPT_COMMANDS } from "./transcript-command-definitions";
import type { WorkbenchAgentCommandContext } from "./workbench-agent-command-definition";

const context: WorkbenchAgentCommandContext = {
  callerHarness: "codex", callerThreadId: "caller", cwd: "C:/repo", knownToolIds: new Set(), workbenchOrigin: null, workbenchRoot: false,
};

function command(action: string) {
  const found = WORKBENCH_TRANSCRIPT_COMMANDS.find(definition => definition.words[1] === action);
  assert.ok(found, action);
  return found;
}

const equivalents: [action: string, cli: string[], json: object][] = [
  ["projects", ["--limit", "5"], { limit: 5 }],
  ["threads", ["--query", "a", "--archived", "true"], { query: "a", archived: true }],
  ["turns", ["--thread", "t", "--limit", "3"], { threads: ["t"], limit: 3 }],
  ["search", ["--query", "a", "--query", "-x", "--kind", "tool", "--thread", "t", "--turn", "u", "--provider"],
    { query: "a -x", kinds: ["tool"], threads: ["t"], turn: "u", provider: true }],
  ["read", ["--thread", "t", "--around", "i", "--context", "2"], { threads: ["t"], around: "i", context: 2 }],
  ["read", ["--thread", "t", "--before", "i"], { threads: ["t"], before: "i" }],
  ["show", ["--thread", "t", "--item", "i", "--opaque"], { threads: ["t"], item: "i", opaque: true }],
  ["stats", ["--since", "2026-01-01", "--phase", "commentary"], { since: Date.parse("2026-01-01"), phase: "commentary" }],
];

test("each transcript tool builds the same request from CLI options and from JSON without an action", async () => {
  for (const [action, cli, json] of equivalents) {
    const fromCli = await command(action).buildRequestFromCli(cli, context);
    const fromJson = await command(action).buildRequestFromJson(json, context);
    assert.deepEqual(fromJson.body, fromCli.body, action);
    assert.equal(fromJson.body?.action, action);
  }
});

test("reading beyond the caller's project takes a Workbench root thread, over CLI and MCP alike", async () => {
  const atRoot = { ...context, workbenchRoot: true };
  const wider: [string[], object][] = [[["--project", "p"], { project: "p" }], [["--all-projects"], { allProjects: true }]];
  for (const [cli, json] of wider) {
    await assert.rejects(command("projects").buildRequestFromCli(cli, context), /Workbench repository root/u);
    await assert.rejects(command("projects").buildRequestFromJson(json, context), /Workbench repository root/u);
    assert.deepEqual((await command("projects").buildRequestFromJson(json, atRoot)).body, (await command("projects").buildRequestFromCli(cli, atRoot)).body);
  }
});

test("JSON input rejects options the CLI does not accept for that action, including action itself", async () => {
  for (const [action, json] of [
    ["read", { threads: ["t"], item: "i" }],
    ["search", { query: "a", around: "i" }],
    ["read", { threads: ["t"], before: "i", after: "j" }],
    ["projects", { kinds: ["tool"] }],
    ["threads", { provider: true }],
    ["read", { action: "stats", threads: ["t"] }],
  ] as const) {
    await assert.rejects(command(action).buildRequestFromJson(json, context), action);
  }
});

test("query rules still reject before a request is built", async () => {
  await assert.rejects(command("read").buildRequestFromJson({}, context), /exactly one --thread/u);
  await assert.rejects(command("search").buildRequestFromCli(["--thread", "t"], context), /--query is required/u);
});
