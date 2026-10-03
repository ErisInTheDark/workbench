/* No exports. Tests protect restricted defaults, one-call approvals, bound caller ownership and the hosted shell. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { WorkbenchItemIdSchema, WorkbenchThreadIdSchema, WorkbenchTurnIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchAdmittedExecution } from "workbench-shared/workbench/provider/provider-execution";
import { parseApprovalCommand } from "./lib/workbench/command-approval-prefix";
import WorkbenchToolAdmissionController, { type WorkbenchToolAdmissionOptions } from "./WorkbenchToolAdmissionController";

function fixture(overrides: Partial<WorkbenchToolAdmissionOptions> = {}) {
  const caller = { harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("12345678-1234-4123-8123-123456789012"), cwd: process.cwd() };
  const calls: WorkbenchAdmittedExecution[] = [];
  const controller = new WorkbenchToolAdmissionController({
    caller, resolve: async () => ({ caller, writableRoots: [caller.cwd], network: false }),
    canonicalize: async value => path.resolve(value),
    approve: async () => { throw new Error("unexpected approval"); },
    execute: async request => { calls.push(request); return { exitCode: 0, stdout: "", stderr: "" }; },
    ...overrides,
  });
  return { controller, calls, caller };
}

test("ordinary calls use server roots and never ask or retry when execution fails", async () => {
  const f = fixture();
  await f.controller.execute({ command: ["echo", "safe"] }, new AbortController().signal);
  assert.deepEqual(f.calls[0]?.permissions, { mode: "restricted", writableRoots: [process.cwd()], network: false });
  let attempts = 0;
  const failed = fixture({ execute: async () => { attempts++; throw new Error("sandbox denied"); } });
  await assert.rejects(failed.controller.execute({ command: ["write"] }, new AbortController().signal), /sandbox denied/);
  assert.equal(attempts, 1);
});

test("explicit escalation approves the immutable exact command once without granting later calls", async () => {
  let approvals = 0;
  const input = { command: ["write", "original"], outsideSandbox: true };
  const f = fixture({ approve: async request => {
    approvals++;
    assert.equal(request.subject.command, "write original");
    input.command[1] = "changed";
    return { kind: "allowOnce" };
  } });
  await f.controller.execute(input, new AbortController().signal);
  assert.deepEqual(f.calls[0]?.command, ["write", "original"]);
  assert.equal(f.calls[0]?.permissions.mode, "approved-unrestricted");
  await f.controller.execute({ command: ["next"] }, new AbortController().signal);
  assert.equal(f.calls[1]?.permissions.mode, "restricted");
  assert.equal(approvals, 1);
});

test("escalation offers saved-rule matching the wrapped script, its justification, and its tool item", async () => {
  const itemId = WorkbenchItemIdSchema.parse("22345678-1234-4123-8123-123456789012");
  const turnId = WorkbenchTurnIdSchema.parse("32345678-1234-4123-8123-123456789012");
  for (const launcher of [["pwsh", "-NoProfile", "-Command"], ["/bin/zsh", "-lc"]]) {
    let seen: Parameters<WorkbenchToolAdmissionOptions["approve"]>[0] | null = null;
    const f = fixture({ approve: async request => { seen = request; return { kind: "allowOnce" }; } });
    await f.controller.execute({
      command: [...launcher, "git fetch --tags origin"], outsideSandbox: true, justification: " needs network ", itemId, turnId,
    }, new AbortController().signal);
    assert.deepEqual(parseApprovalCommand(seen!.subject.command), ["git", "fetch", "--tags", "origin"]);
    assert.equal(seen!.subject.justification, "needs network");
    assert.equal(seen!.itemId, itemId);
    assert.equal(seen!.turnId, turnId);
  }
});

test("decline and cancellation during approval never dispatch", async () => {
  const declined = fixture({ approve: async () => ({ kind: "decline" }) });
  await assert.rejects(declined.controller.execute({ command: ["write"], outsideSandbox: true }, new AbortController().signal), /declined/);
  const refused = fixture({ approve: async () => ({ kind: "decline", feedback: "resubmit with confirmation" }) });
  await assert.rejects(refused.controller.execute({ command: ["write"], outsideSandbox: true }, new AbortController().signal), /resubmit with confirmation/);
  assert.equal(declined.calls.length + refused.calls.length, 0);
  const abort = new AbortController();
  const cancelled = fixture({ approve: async () => { abort.abort(new Error("cancelled")); return { kind: "allowOnce" }; } });
  await assert.rejects(cancelled.controller.execute({ command: ["write"], outsideSandbox: true }, abort.signal), /cancelled/);
  assert.equal(cancelled.calls.length, 0);
});

test("hosted shell binds the provider's trusted caller and tool item, and escalates only after approval", async () => {
  const threadId = WorkbenchThreadIdSchema.parse("12345678-1234-4123-8123-123456789012");
  const itemId = WorkbenchItemIdSchema.parse("22345678-1234-4123-8123-123456789012");
  const turnId = WorkbenchTurnIdSchema.parse("32345678-1234-4123-8123-123456789012");
  const executions: WorkbenchAdmittedExecution[] = [];
  const approvals: Parameters<WorkbenchToolAdmissionOptions["approve"]>[0][] = [];
  let allowed = false;
  const tools = {
    caller: async (_metadata: object, _signal: AbortSignal, context?: { clientScope: string }) => {
      if (context?.clientScope !== "trusted") throw new Error("Scope is not active.");
      return { harness: "claude", threadId, cwd: process.cwd() };
    },
    execute: async (request: WorkbenchAdmittedExecution) => {
      executions.push(request);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };
  const owners = {
    tools,
    approve: async (request: Parameters<WorkbenchToolAdmissionOptions["approve"]>[0]) => {
      approvals.push(request);
      return allowed ? { kind: "allowOnce" as const } : { kind: "decline" as const };
    },
    canonicalize: async (value: string) => path.resolve(value),
  };
  const signal = new AbortController().signal;
  const context = { clientScope: "trusted", itemId, turnId };
  const escalate = { command: "echo approved", outside_sandbox: true };

  await WorkbenchToolAdmissionController.shell(owners, { command: "echo safe" }, { threadId: "forged" }, signal, context);
  assert.deepEqual(executions[0]?.caller, { harness: "claude", threadId, cwd: process.cwd() });
  assert.equal(executions[0]?.permissions.mode, "restricted");
  await assert.rejects(WorkbenchToolAdmissionController.shell(owners, escalate, {}, signal, { clientScope: "forged" }), /not active/u);

  await assert.rejects(WorkbenchToolAdmissionController.shell(owners, escalate, {}, signal, context), /declined/u);
  assert.equal(executions.length, 1);
  allowed = true;
  assert.equal((await WorkbenchToolAdmissionController.shell(owners, escalate, {}, signal, context)).stdout, "ok");
  assert.equal(executions[1]?.permissions.mode, "approved-unrestricted");
  assert.ok(approvals[0]?.subject.command.includes("echo approved"));
  assert.deepEqual([approvals[0]?.caller.threadId, approvals[0]?.itemId, approvals[0]?.turnId], [threadId, itemId, turnId]);
});

test("identity drift and canonical path escape cannot dispatch", async () => {
  const base = fixture();
  const drift = fixture({ resolve: async () => ({
    caller: { ...base.caller, harness: "different" }, writableRoots: [], network: false,
  }) });
  await assert.rejects(drift.controller.execute({ command: ["read"] }, new AbortController().signal), /binding/);
  const escape = fixture({ canonicalize: async value => value.endsWith("link")
    ? path.resolve(process.cwd(), "..") : path.resolve(value) });
  await assert.rejects(escape.controller.execute({ command: ["read"], cwd: "link" }, new AbortController().signal), /outside/);
  assert.equal(drift.calls.length + escape.calls.length, 0);
});
