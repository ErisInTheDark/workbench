/*
 * No exports. Tests protect caller isolation, sandbox forwarding, launch transport, and fail-closed state handling.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CodexCommandExecRequest } from "./CodexCommandExecController";
import WorkbenchShellController from "./CodexShellController";

const caller = { nativeThreadId: "native-session", workbenchThreadId: "workbench-thread" };

function sandboxMeta(cwd: string, permissionProfile: Record<string, unknown> = {
  fileSystem: { entries: [], type: "restricted" },
  network: { enabled: false },
  type: "managed",
}) {
  return {
    "codex/sandbox-state-meta": {
      codexLinuxSandboxExe: null,
      permissionProfile,
      sandboxCwd: pathToFileURL(cwd).toString(),
      useLegacyLandlock: false,
    },
  };
}

test("carries the exact sandbox state through Windows without cmd.exe argument limits", async () => {
  const executions: CodexCommandExecRequest[] = [];
  const workspace = path.resolve("C:/workspace");
  const permissionProfile = {
    fileSystem: {
      entries: [{ access: "write", path: "C:/workspace with spaces" }],
      payload: `quoted "value" ${"x".repeat(9_000)}`,
      type: "restricted",
    },
    network: { enabled: false },
    type: "managed",
  };
  const controller = new WorkbenchShellController({
    commandExec: {
      execute: async (request) => {
        executions.push(request);
        return { exitCode: 5, stderr: "denied\n", stdout: "partial\n" };
      },
    },
    platform: "win32",
  });

  const result = await controller.execute({
    command: "Get-Content 'quoted file.txt'",
    login: false,
    timeout_ms: 4321,
    workdir: "child",
  }, sandboxMeta(workspace, permissionProfile), new AbortController().signal, caller);

  assert.deepEqual(result, {
    cwd: path.resolve(workspace, "child"),
    exitCode: 5,
    shell: "pwsh",
    stderr: "denied\n",
    stdout: "partial\n",
  });
  assert.equal(executions.length, 1);
  const execution = executions[0]!;
  assert.equal(execution.cwd, path.resolve(workspace, "child"));
  assert.equal(execution.timeoutMs, 4321);
  assert.deepEqual(execution.sandboxPolicy, { type: "dangerFullAccess" });
  assert.deepEqual(execution.command.slice(0, 3), ["pwsh", "-NoProfile", "-Command"]);
  assert.doesNotMatch(execution.command.join(" "), /cmd\.exe/iu);
  assert.match(execution.command[3]!, /SetEnvironmentVariable\("WORKBENCH_CODEX_SANDBOX_ARGS_JSON", \$null, "Process"\)/u);
  assert.match(execution.command[3]!, /Get-Command codex -CommandType ExternalScript/u);

  const encodedArgs = execution.env?.WORKBENCH_CODEX_SANDBOX_ARGS_JSON;
  assert.equal(typeof encodedArgs, "string");
  assert.ok(encodedArgs.length > 8_192);
  const codexArgs = JSON.parse(encodedArgs) as string[];
  assert.deepEqual(codexArgs.slice(0, 2), ["sandbox", "--sandbox-state-json"]);
  assert.deepEqual(codexArgs.slice(3), [
    "--",
    "pwsh",
    "-NoProfile",
    "-Command",
    "Get-Content 'quoted file.txt'",
  ]);
  const forwardedState = JSON.parse(codexArgs[2]!);
  assert.deepEqual(forwardedState.permissionProfile, permissionProfile);
  assert.equal(fileURLToPath(forwardedState.sandboxCwd), path.resolve(workspace, "child"));
});

test("launches Codex directly outside Windows", async () => {
  const executions: CodexCommandExecRequest[] = [];
  const workspace = path.resolve("C:/workspace");
  const controller = new WorkbenchShellController({
    commandExec: {
      execute: async (request) => {
        executions.push(request);
        return { exitCode: 0, stderr: "", stdout: "safe\n" };
      },
    },
    platform: "linux",
    shellEnvironment: { NODE_ENV: "test", SHELL: "/bin/bash" },
  });

  const result = await controller.execute({
    command: "printf '%s' 'quoted value'",
    login: false,
  }, sandboxMeta(workspace), new AbortController().signal, caller);

  assert.equal(result.shell, "bash");
  const execution = executions[0]!;
  assert.deepEqual(execution.command.slice(0, 2), ["codex", "sandbox"]);
  assert.deepEqual(execution.command.slice(4), [
    "--",
    "/bin/bash",
    "-c",
    "printf '%s' 'quoted value'",
  ]);
  assert.equal(execution.env?.CODEX_THREAD_ID, caller.nativeThreadId);
  assert.equal(execution.env?.WORKBENCH_THREAD_ID, caller.workbenchThreadId);
  assert.deepEqual(execution.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(fileURLToPath(JSON.parse(execution.command[3]!).sandboxCwd), workspace);
});

test("fails closed when Codex omits the effective sandbox state", async () => {
  let executionCount = 0;
  const controller = new WorkbenchShellController({
    commandExec: {
      execute: async () => {
        executionCount += 1;
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    },
  });

  await assert.rejects(
    controller.execute({ command: "echo safe" }, { threadId: "thread-1" }, new AbortController().signal, caller),
    /valid MCP sandbox state/u,
  );
  assert.equal(executionCount, 0);
});

for (const platform of ["win32", "linux"] as const) test(`shell installs distinct caller identities without leaking between calls on ${platform}`, async () => {
  const workspace = path.resolve("C:/workspace");
  const executions: CodexCommandExecRequest[] = [];
  const environment = Object.freeze({ WORKBENCH_THREAD_ID: "stale-workbench", CODEX_THREAD_ID: "stale-native", WORKBENCH_HARNESS: "opencode" });
  const controller = new WorkbenchShellController({
    platform,
    shellEnvironment: environment,
    commandExec: { execute: async (request) => {
      executions.push(request);
      return { exitCode: 0, stderr: "", stdout: "" };
    } },
  });
  const callers = [
    { nativeThreadId: "native-first", workbenchThreadId: "workbench-first" },
    { nativeThreadId: "native-second", workbenchThreadId: "workbench-second" },
  ];
  for (const caller of callers) {
    await controller.execute({ command: "echo safe", workdir: "child" },
      sandboxMeta(workspace), new AbortController().signal, caller);
  }
  for (const [index, caller] of callers.entries()) {
    const execution = executions[index]!;
    const effectiveEnvironment = { ...environment, ...execution.env };
    assert.equal(effectiveEnvironment.WORKBENCH_THREAD_ID, caller.workbenchThreadId);
    assert.equal(effectiveEnvironment.CODEX_THREAD_ID, caller.nativeThreadId);
    assert.equal(effectiveEnvironment.WORKBENCH_HARNESS, "codex");
    if (platform === "win32") assert.ok(execution.env?.WORKBENCH_CODEX_SANDBOX_ARGS_JSON);
    assert.equal(execution.cwd, path.resolve(workspace, "child"));
  }
  assert.equal(environment.WORKBENCH_THREAD_ID, "stale-workbench");
  assert.equal(environment.CODEX_THREAD_ID, "stale-native");
});
