/*
 * Exports:
 * - tests: protect exact OpenCode session caller binding and admitted Codex sandbox execution.
 */
import assert from "node:assert/strict";
import test from "node:test";
import OpenCodeToolsController from "./OpenCodeToolsController";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

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
