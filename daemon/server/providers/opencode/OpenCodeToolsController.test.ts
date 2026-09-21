/*
 * Exports:
 * - tests: protect exact OpenCode session caller binding and admitted Codex sandbox execution.
 */
import assert from "node:assert/strict";
import test from "node:test";
import OpenCodeToolsController from "./OpenCodeToolsController";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";

test("native mutation admission checks every resource against the resolved caller", async () => {
  const checked: object[] = [];
  const controller: WorkbenchProviderTools = new OpenCodeToolsController({
    resolveCaller: async () => ({ harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("owner"), cwd: "/repo" }),
    execute: async () => { throw new Error("must not execute"); },
    executeReadOnly: async () => { throw new Error("must not execute"); },
  });
  const input = { callerThreadId: null, raw: JSON.stringify({
    sessionID: "native", resources: ["src/old.ts", "src/new.ts", "removed.ts"],
  }) };
  const result = JSON.parse(await controller.patchClaims(input, async value => {
    checked.push(value);
    return { allowed: false, uncoveredPaths: ["src/new.ts", "removed.ts"] };
  }, new AbortController().signal));
  assert.equal(result.allowed, false);
  assert.deepEqual(checked, [{
    cwd: "/repo", harness: "opencode", threadId: "owner",
    paths: ["src/old.ts", "src/new.ts", "removed.ts"],
  }]);
  assert.match(result.reason, /src\/new.ts/);
  assert.match(result.reason, /removed.ts/);
});

test("native admission propagates cancellation and never substitutes caller-supplied ownership", async () => {
  const signal = new AbortController();
  let checked = 0;
  const owner = new OpenCodeToolsController({
    resolveCaller: async () => ({ harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("real-owner"), cwd: "/real" }),
    execute: async () => { throw new Error("must not execute"); },
    executeReadOnly: async () => { throw new Error("must not execute"); },
  });
  const input = { callerThreadId: "forged", raw: JSON.stringify({ sessionID: "native", resources: ["ignored/generated.ts"] }) };
  assert.deepEqual(JSON.parse(await owner.patchClaims(input, async caller => {
    checked++;
    assert.equal(caller.threadId, "real-owner");
    assert.equal(caller.cwd, "/real");
    return { allowed: true, uncoveredPaths: [] };
  }, signal.signal)), { allowed: true });
  await assert.rejects(owner.patchClaims(input, async () => {
    checked++;
    signal.abort(new Error("disposed"));
    return { allowed: true, uncoveredPaths: [] };
  }, signal.signal), /disposed/);
  await assert.rejects(owner.patchClaims(input, async () => {
    checked++;
    return { allowed: true, uncoveredPaths: [] };
  }, signal.signal), /disposed/);
  assert.equal(checked, 2);
});

test("transcript capture requires valid child context and resolves authoritative session ownership", async () => {
  const sessions: string[] = [];
  let starts = 0;
  const owner = new OpenCodeToolsController({
    resolveCaller: async id => {
      sessions.push(id);
      return { harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("owned"), cwd: "/repo" };
    },
    execute: async () => { throw new Error("not executing"); },
    executeReadOnly: async () => { throw new Error("not executing"); },
    transcript: {
      start: async (_input, context, caller) => {
        starts++;
        assert.equal(context.parentID, "parent");
        assert.equal(caller.threadId, "owned");
        return null;
      },
      finish: async () => undefined,
    },
  });
  const signal = new AbortController().signal;
  const input = { tool: "task_get", arguments: {}, metadata: { sessionID: "native" } };
  assert.equal(await owner.transcript.start(input, signal), null);
  await assert.rejects(owner.transcript.start({ ...input, metadata: { ...input.metadata, workbenchTool: { childID: "invalid" } } }, signal));
  assert.equal(starts, 0);
  await owner.transcript.start({ ...input, metadata: { ...input.metadata, workbenchTool: {
    childID: "fcb5b339-e47a-4b57-ae2a-780ca1a8a542", parentID: "parent", assistantMessageID: "assistant",
  } } }, signal);
  assert.deepEqual(sessions, ["native"]);
  assert.equal(starts, 1);
});

test("binds MCP session identity and runs shell through admitted execution", async () => {
  const executions: object[] = [];
  const controller = new OpenCodeToolsController({
    resolveCaller: async () => ({
      harness: "opencode",
        threadId: "00000000-0000-4000-8000-000000000001",
      cwd: process.cwd(),
    } as never),
    execute: async request => {
      executions.push(request);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    executeReadOnly: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });

  const result = await controller.shell(
    { command: "echo ok", login: false },
    { sessionID: "native-session" },
    new AbortController().signal,
  );
  assert.equal(result.stdout, "ok");
  assert.equal(executions.length, 1);
  assert.deepEqual((executions[0] as { caller: object }).caller, {
    harness: "opencode",
    threadId: "00000000-0000-4000-8000-000000000001",
    cwd: process.cwd(),
  });
  assert.deepEqual((executions[0] as { permissions: object }).permissions, {
    mode: "restricted",
    writableRoots: [process.cwd()],
    network: false,
  });
});
