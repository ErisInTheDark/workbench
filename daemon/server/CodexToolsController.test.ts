/*
 * No production exports. Tests protect caller identity and cancellation before sandbox execution.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { CodexCommandExecRequest } from "./CodexCommandExecController";
import CodexToolsController from "./CodexToolsController";

test("native metadata resolves WB identity before executing a shell", async () => {
  const calls: object[] = [];
  const controller = new CodexToolsController({
    resolvePatchCaller: async () => { throw new Error("unexpected patch"); },
    commandExec: { execute: async () => { throw new Error("unexpected execution"); } },
    readCallerThread: async nativeId => {
      assert.equal(nativeId, "native-thread");
      return { id: WorkbenchThreadIdSchema.parse("wb-thread"), cwd: "/project" };
    },
    shell: { execute: async (input, _metadata, _signal, caller) => {
      calls.push({ input, caller });
      return { cwd: "/project/child", exitCode: 0, shell: "sh", stdout: "", stderr: "" };
    } },
  });
  const signal = new AbortController().signal;
  const metadata = { threadId: "native-thread", cwd: "/untrusted" };
  assert.deepEqual(await controller.caller(metadata, signal), {
    harness: "codex", threadId: "wb-thread", cwd: "/project",
  });
  await controller.shell({ command: "pwd", workdir: "child" }, metadata, signal);
  assert.deepEqual(calls, [{
    input: { command: "pwd", workdir: "child" },
    caller: { nativeThreadId: "native-thread", workbenchThreadId: "wb-thread" },
  }]);
});

test("cancelled caller lookup cannot launch a command and missing identity cannot trigger lookup", async () => {
  const cancellation = new AbortController();
  let reads = 0;
  const controller = new CodexToolsController({
    resolvePatchCaller: async () => { throw new Error("unexpected patch"); },
    commandExec: { execute: async () => { throw new Error("unexpected execution"); } },
    readCallerThread: async () => {
      reads++;
      cancellation.abort(new Error("caller cancelled"));
      return { id: WorkbenchThreadIdSchema.parse("wb-thread"), cwd: "/project" };
    },
    shell: { execute: async () => { throw new Error("must not execute"); } },
  });
  await assert.rejects(controller.caller({}, cancellation.signal), /trusted MCP thread identity/u);
  assert.equal(reads, 0);
  await assert.rejects(controller.shell({ command: "pwd" }, { threadId: "native-thread" }, cancellation.signal), /caller cancelled/u);
  assert.equal(reads, 1);
});

test("executes Workbench read-only commands through native Codex command execution", async () => {
  const calls: CodexCommandExecRequest[] = [];
  const controller = new CodexToolsController({
    resolvePatchCaller: async () => { throw new Error("unexpected patch"); },
    commandExec: { execute: async request => {
      calls.push(request);
      return { exitCode: 0, stdout: "match\n", stderr: "" };
    } },
    readCallerThread: async () => { throw new Error("unexpected caller lookup"); },
    shell: { execute: async () => { throw new Error("unexpected shell"); } },
  });
  const request = {
    command: ["rg", "--no-config", "needle"],
    cwd: "C:/workspace",
    env: { RIPGREP_CONFIG_PATH: null },
  };

  assert.deepEqual(await controller.executeReadOnly(request, new AbortController().signal), {
    exitCode: 0, stdout: "match\n", stderr: "",
  });
  assert.deepEqual(calls, [{
    ...request,
    disableTimeout: true,
    sandboxPolicy: { type: "dangerFullAccess" },
  }]);
});
