/* No exports. Tests protect restricted defaults, one-call approvals and bound caller ownership. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchAdmittedExecution } from "workbench-shared/workbench/provider/provider-execution";
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
    assert.deepEqual(request.command, ["write", "original"]);
    input.command[1] = "changed";
    request.command[1] = "also changed";
    return true;
  } });
  await f.controller.execute(input, new AbortController().signal);
  assert.deepEqual(f.calls[0]?.command, ["write", "original"]);
  assert.equal(f.calls[0]?.permissions.mode, "approved-unrestricted");
  await f.controller.execute({ command: ["next"] }, new AbortController().signal);
  assert.equal(f.calls[1]?.permissions.mode, "restricted");
  assert.equal(approvals, 1);
});

test("decline and cancellation during approval never dispatch", async () => {
  const declined = fixture({ approve: async () => false });
  await assert.rejects(declined.controller.execute({ command: ["write"], outsideSandbox: true }, new AbortController().signal), /declined/);
  assert.equal(declined.calls.length, 0);
  const abort = new AbortController();
  const cancelled = fixture({ approve: async () => { abort.abort(new Error("cancelled")); return true; } });
  await assert.rejects(cancelled.controller.execute({ command: ["write"], outsideSandbox: true }, abort.signal), /cancelled/);
  assert.equal(cancelled.calls.length, 0);
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
