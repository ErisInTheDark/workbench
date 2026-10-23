/*
 * No exports. Tests protect the exact live scenario allowlist and daemon request shape.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkbenchAgentCliCommand } from "../cli/workbench-agent-cli-commands";
import { WORKBENCH_LIVE_SCENARIO_COMMANDS } from "./live-scenario-command-definition";

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
    [["--claude=fake"], { claude: "fake" }],
    [["--future-provider=fake"], { "future-provider": "fake" }],
    [["--codex=paid", "--opencode=fake"], { codex: "paid", opencode: "fake" }],
  ] as const) {
    const parsed = await parseWorkbenchAgentCliCommand(["test", "live", ...flags, "--", file], context);
    assert.equal(parsed.kind, "request");
    if (parsed.kind !== "request") continue;
    assert.deepEqual(parsed.request, {
      body: { cwd: context.cwd, file, providers },
      method: "POST",
      path: "/internal/test/live-scenario",
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

test("the installer scenario takes no provider modes, and provider journeys still require them", async () => {
  const install = "test/install/InstallSandbox.scenario.test.ts";
  const parsed = await parseWorkbenchAgentCliCommand(["test", "live", "--", install], context);
  assert.equal(parsed.kind, "request");
  if (parsed.kind === "request") {
    assert.deepEqual(parsed.request.body, { cwd: context.cwd, file: install });
    assert.equal(parsed.request.path, "/internal/test/live-scenario");
  }
  for (const args of [
    ["test", "live", "--codex=fake", "--", install],
    ["test", "live", "--", "test/scenarios/thread.scenario.test.ts"],
    ["test", "live", "--", "test/arbitrary.test.ts"],
  ]) {
    assert.equal((await parseWorkbenchAgentCliCommand(args, context)).kind, "error");
  }
});

test("tool JSON input builds the same request as the CLI and keeps the per-scenario rules", async () => {
  const live = WORKBENCH_LIVE_SCENARIO_COMMANDS.find(command => command.words.join(" ") === "test live")!;
  const thread = "test/scenarios/thread.scenario.test.ts";
  const install = "test/install/InstallSandbox.scenario.test.ts";
  for (const [cli, json] of [
    [["--codex=fake", "--claude=fake", "--", thread], { file: thread, providers: { codex: "fake", claude: "fake" } }],
    [["--", install], { file: install }],
  ] as const) {
    assert.deepEqual((await live.buildRequestFromJson(json, context)).body, (await live.buildRequestFromCli([...cli], context)).body);
  }
  await assert.rejects(live.buildRequestFromJson({ file: thread }, context), /provider modes/u);
  await assert.rejects(live.buildRequestFromJson({ file: install, providers: { codex: "fake" } }, context), /no provider modes/u);
});

test("live provider cancellation targets only the trusted runner", async () => {
  const parsed = await parseWorkbenchAgentCliCommand(["test", "live", "cancel"], context);
  assert.equal(parsed.kind, "request");
  if (parsed.kind !== "request") return;
  assert.deepEqual(parsed.request, {
    body: {},
    method: "POST",
    path: "/internal/test/live-scenario/cancel",
    responseKind: "native",
  });
});
