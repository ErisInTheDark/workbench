/*
 * No exports. Tests protect request-scoped managed store reads and human-only writes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkbenchAgentCliCommand } from "../cli/workbench-agent-cli-commands";
import { listWorkbenchAgentCommands } from "./workbench-agent-command-registry";

const human = { callerHarness: "codex", callerThreadId: null, cwd: "C:/project", workbenchOrigin: null };
const dangerousAccess = "DANGEROUSLY_ACCESS_ENV_VARS";

test("human terminals reach the store with exact keys and values", async () => {
  const get = await parseWorkbenchAgentCliCommand(["store", "get", "API_KEY"], human);
  assert.deepEqual(get.kind === "request" && get.request, {
    body: { action: "get", cwd: "C:/project", key: "API_KEY" }, method: "POST", path: "/internal/store", responseKind: "native",
  });
  const set = await parseWorkbenchAgentCliCommand(["store", "set", "API_KEY", "--", "-v; $(x)"], human);
  assert.deepEqual(set.kind === "request" && set.request.body, { action: "set", cwd: "C:/project", key: "API_KEY", value: "-v; $(x)" });
});

test("managed agents need deliberate access for reads and can never write", async t => {
  const saved = process.env[dangerousAccess];
  delete process.env[dangerousAccess];
  t.after(() => {
    if (saved === undefined) delete process.env[dangerousAccess];
    else process.env[dangerousAccess] = saved;
  });
  for (const argv of [["store", "get", "API_KEY"], ["store", "set", "API_KEY", "v"]]) {
    const parsed = await parseWorkbenchAgentCliCommand(argv, { ...human, callerThreadId: "thread-1" });
    assert.equal(parsed.kind, "error");
  }
  process.env[dangerousAccess] = "true";
  assert.equal((await parseWorkbenchAgentCliCommand(
    ["store", "get", "API_KEY"],
    { ...human, callerThreadId: "thread-1" },
  )).kind, "error");
  process.env[dangerousAccess] = "1";
  assert.equal((await parseWorkbenchAgentCliCommand(
    ["store", "get", "API_KEY"],
    { ...human, callerThreadId: "thread-1" },
  )).kind, "error");
  const get = await parseWorkbenchAgentCliCommand(
    ["store", "get", "API_KEY"],
    { ...human, callerThreadId: "thread-1", allowStoreRead: true },
  );
  assert.deepEqual(get.kind === "request" && get.request.body, { action: "get", cwd: "C:/project", key: "API_KEY" });
  assert.equal((await parseWorkbenchAgentCliCommand(
    ["store", "set", "API_KEY", "v"],
    { ...human, callerThreadId: "thread-1", allowStoreRead: true },
  )).kind, "error");
});

test("store commands stay out of help and MCP", async () => {
  for (const argv of [["--help"], ["help"]]) {
    const parsed = await parseWorkbenchAgentCliCommand(argv, human);
    assert.equal(parsed.kind, "help");
    assert.doesNotMatch(parsed.kind === "help" ? parsed.help : "", /\bstore\b/);
  }
  const store = listWorkbenchAgentCommands().filter(command => command.words[0] === "store");
  assert.equal(store.length, 2);
  assert.ok(store.every(command => command.hideFromMcp && command.helpGroups.length === 0));
});
