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

test("live provider tests admit only their exact scenario files", async () => {
  for (const [provider, file] of [
    ["codex", "test/scenarios/codex.scenario.test.ts"],
    ["opencode", "test/scenarios/opencode.scenario.test.ts"],
  ] as const) {
    const parsed = await parseWorkbenchAgentCliCommand(["test", "live", provider, "--", file], context);
    assert.equal(parsed.kind, "request");
    if (parsed.kind !== "request") continue;
    assert.deepEqual(parsed.request, {
      body: { cwd: context.cwd, file, provider },
      method: "POST",
      path: "/internal/test/live-provider",
      responseKind: "native",
    });
  }

  for (const args of [
    ["test", "live", "opencode"],
    ["test", "live", "other", "--", "test/scenarios/opencode.scenario.test.ts"],
    ["test", "live", "opencode", "--", "test/scenarios/codex.scenario.test.ts"],
    ["test", "live", "opencode", "--", "test/arbitrary.test.ts"],
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
