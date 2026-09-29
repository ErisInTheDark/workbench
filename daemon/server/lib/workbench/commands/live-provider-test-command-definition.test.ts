/*
 * No exports. Tests protect the exact live-provider scenario allowlist and daemon request shape.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkbenchAgentCliCommand } from "../cli/workbench-agent-cli-commands";

const context = {
  callerHarness: "codex",
  callerThreadId: "thread-1",
  cwd: "C:/git/web/workbench",
  workbenchOrigin: "http://127.0.0.1:4500",
};

test("live provider tests admit only explicit modes and the exact scenario", async () => {
  const file = "test/scenarios/thread.scenario.test.ts";
  for (const [flags, providers] of [
    [["--codex=paid"], { codex: "paid" }],
    [["--opencode=fake"], { opencode: "fake" }],
    [["--codex=paid", "--opencode=fake"], { codex: "paid", opencode: "fake" }],
  ] as const) {
    const parsed = await parseWorkbenchAgentCliCommand(["test", "live", ...flags, "--", file], context);
    assert.equal(parsed.kind, "request");
    if (parsed.kind !== "request") continue;
    assert.deepEqual(parsed.request, {
      body: { cwd: context.cwd, file, providers },
      method: "POST",
      path: "/internal/test/live-provider",
      responseKind: "native",
    });
  }

  for (const args of [
    ["test", "live", "--opencode=paid"],
    ["test", "live", "opencode", "--", file],
    ["test", "live", "--codex=paid", "--codex=fake", "--", file],
    ["test", "live", "other", "--", "test/scenarios/thread.scenario.test.ts"],
    ["test", "live", "--opencode=paid", "--", "test/scenarios/codex.scenario.test.ts"],
    ["test", "live", "--opencode=paid", "--", "test/arbitrary.test.ts"],
  ]) {
    assert.equal((await parseWorkbenchAgentCliCommand(args, context)).kind, "error");
  }
});

test("live provider cancellation targets only the trusted runner", async () => {
  const parsed = await parseWorkbenchAgentCliCommand(["test", "live", "cancel"], context);
  assert.equal(parsed.kind, "request");
  if (parsed.kind !== "request") return;
  assert.deepEqual(parsed.request, {
    body: {},
    method: "POST",
    path: "/internal/test/live-provider/cancel",
    responseKind: "native",
  });
});
