/* No production exports. Tests protect exact sandbox forwarding, platform launch transport, and fail-closed state handling. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CodexCommandExecRequest } from "./CodexCommandExecController";
import WorkbenchShellController from "./WorkbenchShellController";

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
  }, sandboxMeta(workspace, permissionProfile), new AbortController().signal);

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
  }, sandboxMeta(workspace), new AbortController().signal);

  assert.equal(result.shell, "bash");
  const execution = executions[0]!;
  assert.deepEqual(execution.command.slice(0, 2), ["codex", "sandbox"]);
  assert.deepEqual(execution.command.slice(4), [
    "--",
    "/bin/bash",
    "-c",
    "printf '%s' 'quoted value'",
  ]);
  assert.equal(execution.env, undefined);
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
    controller.execute({ command: "echo safe" }, { threadId: "thread-1" }, new AbortController().signal),
    /valid MCP sandbox state/u,
  );
  assert.equal(executionCount, 0);
});

test("shell environment exposes Workbench identity without changing native sandbox context", async () => {
  const workspace = path.resolve("C:/workspace");
  const executions: CodexCommandExecRequest[] = [];
  const threadId = "97d84a45-0d43-4d20-a996-e6b8bd8ad149";
  const controller = new WorkbenchShellController({
    platform: "win32",
    resolveThreadId: async (nativeId, cwd) => {
      assert.equal(nativeId, "native-session");
      assert.equal(cwd, workspace);
      return threadId;
    },
    commandExec: { execute: async (request) => {
      executions.push(request);
      return { exitCode: 0, stderr: "", stdout: "" };
    } },
  });
  await controller.execute({ command: "Get-Location", workdir: "child" },
    { ...sandboxMeta(workspace), threadId: "native-session" }, new AbortController().signal);
  assert.equal(executions[0]?.env?.WORKBENCH_THREAD_ID, threadId);
  assert.equal(executions[0]?.env?.WORKBENCH_HARNESS, "codex");
  assert.ok(executions[0]?.env?.WORKBENCH_CODEX_SANDBOX_ARGS_JSON);
  assert.equal(executions[0]?.cwd, path.resolve(workspace, "child"));
  await assert.rejects(controller.execute({ command: "Get-Location" }, sandboxMeta(workspace), new AbortController().signal),
    /trusted MCP thread identity/u);
  assert.equal(executions.length, 1);
});
