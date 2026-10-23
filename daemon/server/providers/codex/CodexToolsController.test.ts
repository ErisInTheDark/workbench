/*
 * No production exports. Tests protect trusted caller identity and cancellation before any shell admission.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import CodexToolsController from "./CodexToolsController";

test("native metadata resolves WB identity and the thread's own working directory", async () => {
  const controller = new CodexToolsController({
    resolvePatchCaller: async () => { throw new Error("unexpected patch"); },
    readCallerThread: async nativeId => {
      assert.equal(nativeId, "native-thread");
      return { id: WorkbenchThreadIdSchema.parse("wb-thread"), cwd: "/project" };
    },
    shell: {},
  });
  assert.deepEqual(await controller.caller({ threadId: "native-thread", cwd: "/untrusted" }, new AbortController().signal), {
    harness: "codex", threadId: "wb-thread", cwd: "/project",
  });
});

test("cancelled caller lookup fails and missing identity cannot trigger lookup", async () => {
  const cancellation = new AbortController();
  let reads = 0;
  const controller = new CodexToolsController({
    resolvePatchCaller: async () => { throw new Error("unexpected patch"); },
    readCallerThread: async () => {
      reads++;
      cancellation.abort(new Error("caller cancelled"));
      return { id: WorkbenchThreadIdSchema.parse("wb-thread"), cwd: "/project" };
    },
    shell: {},
  });
  await assert.rejects(controller.caller({}, cancellation.signal), /trusted MCP thread identity/u);
  assert.equal(reads, 0);
  await assert.rejects(controller.caller({ threadId: "native-thread" }, cancellation.signal), /caller cancelled/u);
  assert.equal(reads, 1);
});
