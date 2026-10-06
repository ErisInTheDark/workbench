/*
 * No exports. Tests protect where prepared agent commands run: expensive slots, the sandbox executor, and approved spawns.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchShellRun } from "./provider-execution";
import WorkbenchShellRunner from "./WorkbenchShellRunner";

const caller = { harness: "claude", threadId: WorkbenchThreadIdSchema.parse("other"), cwd: process.cwd() };
const sandboxedRun = (label: string, expensive: boolean): WorkbenchShellRun => ({
  kind: "sandboxed", label, expensive,
  request: {
    command: ["sh", "-c", label], cwd: process.cwd(), permissions: { type: "disabled" },
    windowsSandboxLevel: "disabled", windowsSandboxPrivateDesktop: false, workspaceRoots: [process.cwd()],
  },
});

test("expensive runs take a machine-wide slot before starting; approved runs spawn directly with their own identity", async () => {
  const admitted: string[] = [];
  const executed: string[] = [];
  const approved: string[] = [];
  const runner = new WorkbenchShellRunner({
    executor: { execute: async request => { executed.push(request.command.at(-1)!); return { exitCode: 0, stdout: "", stderr: "" }; } },
    capacity: { run: async (label, _signal, task) => { admitted.push(label); return await task(); } },
    executeApproved: async request => { approved.push(request.caller.threadId); return { exitCode: 0, stdout: "", stderr: "" }; },
  });
  const signal = new AbortController().signal;
  await runner.run(sandboxedRun("cargo build", true), signal);
  await runner.run(sandboxedRun("git status", false), signal);
  await runner.run({
    kind: "approved", label: "pnpm test", expensive: true,
    request: { caller, command: ["pnpm", "test"], cwd: process.cwd(), permissions: { mode: "approved-unrestricted" } },
  }, signal);
  assert.deepEqual(admitted, ["cargo build", "pnpm test"]);
  assert.deepEqual(executed, ["cargo build", "git status"]);
  assert.deepEqual(approved, ["other"]);
});
