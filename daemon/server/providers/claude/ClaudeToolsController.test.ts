/*
 * No exports. Protect server-owned MCP scope identity against model-supplied metadata.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
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

test("Claude outside-sandbox shell requires a Workbench decision bound to the trusted scope and its tool item", async () => {
  const threadId = WorkbenchThreadIdSchema.parse("11111111-1111-4111-8111-111111111111");
  const itemId = WorkbenchItemIdSchema.parse("22222222-2222-4222-8222-222222222222");
  const turnId = WorkbenchTurnIdSchema.parse("33333333-3333-4333-8333-333333333333");
  const decisions: Array<{ command: string; itemId: string | null; turnId: string | null }> = [];
  const permissions: string[] = [];
  let allowed = false;
  const owner = new ClaudeToolsController({
    threads: {
      resolveScope(scope: string) {
        if (scope !== "trusted") throw new Error("Scope is not active.");
        return { threadId, cwd: process.cwd() };
      },
      async requestShellApproval(request: { subject: { command: string }; itemId: string | null; turnId: string | null }) {
        decisions.push({ command: request.subject.command, itemId: request.itemId, turnId: request.turnId });
        return allowed ? { kind: "allowOnce" } : { kind: "decline" };
      },
    } as unknown as ClaudeThreadOperations,
    transcript: {} as ClaudeTranscriptAdapter,
    execute: async request => {
      permissions.push(request.permissions.mode);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });
  const input = { command: "echo approved", outside_sandbox: true };
  const context = { clientScope: "trusted", itemId, turnId };
  const signal = new AbortController().signal;
  await assert.rejects(owner.shell(input, { threadId: "forged" }, signal, context), /declined/u);
  assert.deepEqual(permissions, []);
  allowed = true;
  assert.equal((await owner.shell(input, {}, signal, context)).stdout, "ok");
  assert.equal(permissions[0], "approved-unrestricted");
  assert.equal(decisions.length, 2);
  assert.ok(decisions[0]?.command.includes("echo approved"));
  assert.deepEqual([decisions[0]?.itemId, decisions[0]?.turnId], [itemId, turnId]);
});
