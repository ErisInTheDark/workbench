/*
 * No exports. Protect server-owned MCP scope identity against model-supplied metadata.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import ClaudeToolsController from "./ClaudeToolsController";
import type ClaudeThreadOperations from "./ClaudeThreadOperations";
import type ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";

test("Claude MCP caller comes from the server scope, never model metadata", async () => {
  const threadId = WorkbenchThreadIdSchema.parse("11111111-1111-4111-8111-111111111111");
  const owner = new ClaudeToolsController({
    threads: {
      resolveScope(scope: string) {
        if (scope !== "trusted") throw new Error("Scope is not active.");
        return { threadId, cwd: "C:/workspace" };
      },
    } as ClaudeThreadOperations,
    transcript: {} as ClaudeTranscriptAdapter,
    prepareExecution: async () => { throw new Error("unexpected execution"); },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await owner.caller({ threadId: "attacker", cwd: "C:/attacker" }, signal, {
    clientScope: "trusted",
  }), { harness: "claude", threadId, cwd: "C:/workspace" });
  await assert.rejects(owner.caller({ threadId }, signal, { clientScope: "untrusted" }), /Scope is not active/u);
  await assert.rejects(owner.caller({ threadId }, signal), /server-owned client scope/u);
});
