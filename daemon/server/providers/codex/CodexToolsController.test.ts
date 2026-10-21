/*
 * No production exports. Tests protect caller identity and cancellation before sandbox preparation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import CodexToolsController from "./CodexToolsController";

test("native metadata resolves WB identity before executing a shell", async () => {
  const calls: object[] = [];
  const controller = new CodexToolsController({
    resolvePatchCaller: async () => { throw new Error("unexpected patch"); },
    readCallerThread: async nativeId => {
      assert.equal(nativeId, "native-thread");
      return { id: WorkbenchThreadIdSchema.parse("wb-thread"), cwd: "/project" };
    },
    shell: { prepare: async (input, _metadata, _signal, caller) => {
      calls.push({ input, caller });
      return { cwd: "/project/child", shell: "sh", run: { kind: "sandboxed", label: "pwd", expensive: false, request: {
        command: ["sh", "-c", "pwd"], cwd: "/project/child", permissions: { type: "disabled" },
        windowsSandboxLevel: "disabled", windowsSandboxPrivateDesktop: false, workspaceRoots: ["/project"],
      } } };
    } },
  });
  const signal = new AbortController().signal;
  const metadata = { threadId: "native-thread", cwd: "/untrusted" };
  assert.deepEqual(await controller.caller(metadata, signal), {
    harness: "codex", threadId: "wb-thread", cwd: "/project",
  });
  await controller.prepareShell({ command: "pwd", workdir: "child" }, metadata, signal);
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
    readCallerThread: async () => {
      reads++;
      cancellation.abort(new Error("caller cancelled"));
      return { id: WorkbenchThreadIdSchema.parse("wb-thread"), cwd: "/project" };
    },
    shell: { prepare: async () => { throw new Error("must not prepare"); } },
  });
  await assert.rejects(controller.caller({}, cancellation.signal), /trusted MCP thread identity/u);
  assert.equal(reads, 0);
  await assert.rejects(controller.prepareShell({ command: "pwd" }, { threadId: "native-thread" }, cancellation.signal), /caller cancelled/u);
  assert.equal(reads, 1);
});
