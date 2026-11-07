/*
 * No exports. Tests protect caller isolation, Windows sandbox level forwarding and permission-safe admitted execution.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CodexExecRequest } from "./codex-exec-protocol";
import WorkbenchShellController from "./CodexShellController";
import type { CodexWindowsSandboxLevel } from "./CodexWindowsSandbox";
import type { WorkbenchAdmittedExecution, WorkbenchShellRun } from "../provider-execution";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

const unusedExecutor = { execute: async (): Promise<never> => { throw new Error("prepared shells never run here"); } };

function windowsSandbox(level: CodexWindowsSandboxLevel) {
  return { level: async (_cwd: string) => level };
}

function sandboxed(run: WorkbenchShellRun): CodexExecRequest {
  assert.equal(run.kind, "sandboxed");
  return run.request as CodexExecRequest;
}

function admitted(overrides: Partial<WorkbenchAdmittedExecution> = {}): WorkbenchAdmittedExecution {
  return {
    caller: { harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("other"), cwd: process.cwd() },
    command: ["echo"], cwd: process.cwd(),
    permissions: { mode: "restricted", writableRoots: [process.cwd()], network: false },
    ...overrides,
  };
}

test("admitted commands use the Windows sandbox level the daemon resolved", async () => {
  for (const level of ["elevated", "restricted-token"] as const) {
    const controller = new WorkbenchShellController({ executor: unusedExecutor, windowsSandbox: windowsSandbox(level) });
    const execution = sandboxed(await controller.prepareAdmitted(admitted(), new AbortController().signal));
    assert.equal(execution.windowsSandboxLevel, level);
  }
});

test("admitted non-Codex calls use their own WB identity and only admitted permissions", async () => {
  const controller = new WorkbenchShellController({
    executor: unusedExecutor,
    windowsSandbox: windowsSandbox("elevated"),
    platform: "win32",
    powerShellExecutable: async () => "C:\\workbench\\powershell\\pwsh.exe",
  });
  const input = admitted();
  const restricted = sandboxed(await controller.prepareAdmitted(input, new AbortController().signal));
  const approved = await controller.prepareAdmitted({ ...input, permissions: { mode: "approved-unrestricted" } }, new AbortController().signal);
  assert.equal(restricted.permissions.type, "managed");
  assert.deepEqual(restricted.env, { CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: "other", WORKBENCH_HARNESS: "opencode" });
  assert.ok(approved.kind === "approved");
  assert.equal(approved.request.caller.threadId, "other");
  const powerShell = sandboxed(await controller.prepareAdmitted({
    ...input, command: ["pwsh", "-Command", "Get-Date"],
  }, new AbortController().signal));
  assert.deepEqual(powerShell.command, ["C:\\workbench\\powershell\\pwsh.exe", "-Command", "Get-Date"]);
  const windowsPowerShell = sandboxed(await controller.prepareAdmitted({
    ...input, command: ["powershell.exe", "-Command", "Get-Date"],
  }, new AbortController().signal));
  assert.deepEqual(windowsPowerShell.command, ["powershell.exe", "-Command", "Get-Date"]);
});

test("only commands marked expensive are prepared for a machine-wide slot", async () => {
  const controller = new WorkbenchShellController({
    platform: "linux",
    windowsSandbox: windowsSandbox("restricted-token"),
    executor: unusedExecutor,
  });
  const signal = new AbortController().signal;
  const runs = [
    await controller.prepareAdmitted(admitted({ command: ["cargo", "build"], expensive: true }), signal),
    await controller.prepareAdmitted(admitted({ command: ["git", "status"] }), signal),
  ];
  assert.deepEqual(runs.filter(run => run.expensive).map(run => run.label), ["cargo build"]);
});
