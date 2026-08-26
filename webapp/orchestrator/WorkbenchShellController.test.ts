/* No production exports. Tests protect exact sandbox-state delegation, host-shell argv, and fail-closed metadata handling. */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CodexCommandExecRequest } from "./CodexCommandExecController";
import WorkbenchShellController from "./WorkbenchShellController";

function sandboxMeta(cwd: string) {
  return {
    "codex/sandbox-state-meta": {
      codexLinuxSandboxExe: null,
      permissionProfile: {
        fileSystem: { entries: [], type: "restricted" },
        network: { enabled: false },
        type: "managed",
      },
      sandboxCwd: pathToFileURL(cwd).toString(),
      useLegacyLandlock: false,
    },
  };
}

test("runs one PowerShell command through the exact supplied Codex sandbox state", async () => {
  const executions: CodexCommandExecRequest[] = [];
  const workspace = path.resolve("C:/workspace");
  const controller = new WorkbenchShellController({
    commandExec: {
      execute: async (request) => {
        executions.push(request);
        return { exitCode: 5, stderr: "denied\n", stdout: "partial\n" };
      },
    },
    getCodexSpawnDescriptor: ({ args }) => ({ args, command: "resolved-codex" }),
    platform: "win32",
  });

  const result = await controller.execute({
    command: "Get-Content secret.txt",
    login: false,
    timeout_ms: 4321,
    workdir: "child",
  }, sandboxMeta(workspace), new AbortController().signal);

  assert.deepEqual(result, { exitCode: 5, stderr: "denied\n", stdout: "partial\n" });
  assert.equal(executions.length, 1);
  const execution = executions[0]!;
  assert.equal(execution.cwd, path.resolve(workspace, "child"));
  assert.equal(execution.timeoutMs, 4321);
  assert.deepEqual(execution.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(execution.command[0], "resolved-codex");
  assert.deepEqual(execution.command.slice(1, 4), ["sandbox", "--sandbox-state-json", execution.command[3]]);
  assert.deepEqual(execution.command.slice(4), ["--", "pwsh", "-NoProfile", "-Command", "Get-Content secret.txt"]);
  const forwardedState = JSON.parse(execution.command[3]!) as { permissionProfile: object; sandboxCwd: string };
  assert.equal(fileURLToPath(forwardedState.sandboxCwd), path.resolve(workspace, "child"));
  assert.deepEqual(forwardedState.permissionProfile, sandboxMeta(workspace)["codex/sandbox-state-meta"].permissionProfile);
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
