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
    execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await owner.caller({ threadId: "attacker", cwd: "C:/attacker" }, signal, {
    clientScope: "trusted",
  }), { harness: "claude", threadId, cwd: "C:/workspace" });
  await assert.rejects(owner.caller({ threadId }, signal, { clientScope: "untrusted" }), /Scope is not active/u);
  await assert.rejects(owner.caller({ threadId }, signal), /server-owned client scope/u);
});

test("Claude outside-sandbox shell requires a Workbench decision bound to the trusted scope", async () => {
  const threadId = WorkbenchThreadIdSchema.parse("11111111-1111-4111-8111-111111111111");
  const decisions: string[][] = [];
  const permissions: string[] = [];
  let allowed = false;
  const owner = new ClaudeToolsController({
    threads: {
      resolveScope(scope: string) {
        if (scope !== "trusted") throw new Error("Scope is not active.");
        return { threadId, cwd: process.cwd() };
      },
      async requestShellApproval(request: { command: string[] }) {
        decisions.push(request.command);
        return allowed;
      },
    } as unknown as ClaudeThreadOperations,
    transcript: {} as ClaudeTranscriptAdapter,
    execute: async request => {
      permissions.push(request.permissions.mode);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });
  const input = { command: "echo approved", outside_sandbox: true };
  const context = { clientScope: "trusted" };
  const signal = new AbortController().signal;
  await assert.rejects(owner.shell(input, { threadId: "forged" }, signal, context), /declined/u);
  assert.deepEqual(permissions, []);
  allowed = true;
  assert.equal((await owner.shell(input, {}, signal, context)).stdout, "ok");
  assert.equal(permissions[0], "approved-unrestricted");
  assert.equal(decisions.length, 2);
  assert.ok(decisions[0]?.some(part => part.includes("echo approved")));
});
