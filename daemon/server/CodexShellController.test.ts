/*
 * No exports. Tests protect caller isolation, sandbox forwarding and permission-safe native execution.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import type { CodexExecRequest } from "./codex-exec-protocol";
import WorkbenchShellController from "./CodexShellController";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

const caller = { nativeThreadId: "native-session", workbenchThreadId: "workbench-thread" };

test("shell delegates sandbox permissions to the persistent executor rather than launching another Codex process", async () => {
  const executions: CodexExecRequest[] = [];
  const controller = new WorkbenchShellController({
    platform: "linux",
    shellEnvironment: { SHELL: "/bin/bash" },
    readConfiguration: async () => ({ config: {} }),
    executor: { execute: async request => {
      executions.push(request);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    } },
  });
  await controller.execute({ command: "printf ok" }, sandboxMeta(process.cwd()), new AbortController().signal, caller);
  assert.equal(executions[0]?.command[0], "/bin/bash", "execute the requested shell inside the persistent sandbox owner");
});

function sandboxMeta(cwd: string, permissionProfile: Record<string, unknown> = {
  file_system: { entries: [], type: "restricted" },
  network: "restricted",
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

test("carries sandbox permissions and the requested shell directly through Windows execution", async () => {
  const executions: CodexExecRequest[] = [];
  const workspace = path.resolve("C:/workspace");
  const permissionProfile = {
    file_system: {
      entries: [{ access: "write", path: { type: "path", path: pathToFileURL(workspace).href } }],
      type: "restricted",
    },
    network: "restricted",
    type: "managed",
  };
  const controller = new WorkbenchShellController({
    readConfiguration: async () => ({ config: { windows: { sandbox: "elevated" } } }),
    executor: {
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
  assert.deepEqual(execution.permissions, permissionProfile);
  assert.equal(execution.windowsSandboxLevel, "elevated");
  assert.equal(execution.windowsSandboxPrivateDesktop, true);
  assert.deepEqual(execution.command, [
    "pwsh",
    "-NoProfile",
    "-Command",
    "Get-Content 'quoted file.txt'",
  ]);
  assert.deepEqual(execution.workspaceRoots, [workspace]);
});

test("preserves the selected POSIX shell and caller identity", async () => {
  const executions: CodexExecRequest[] = [];
  const workspace = path.resolve("C:/workspace");
  const controller = new WorkbenchShellController({
    readConfiguration: async () => ({ config: {} }),
    executor: {
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
  assert.deepEqual(execution.command, [
    "/bin/bash",
    "-c",
    "printf '%s' 'quoted value'",
  ]);
  assert.equal(execution.env?.CODEX_THREAD_ID, caller.nativeThreadId);
  assert.equal(execution.env?.WORKBENCH_THREAD_ID, caller.workbenchThreadId);
  assert.equal(execution.permissions.type, "managed");
  assert.equal(execution.cwd, workspace);
});

test("fails closed when Codex omits the effective sandbox state", async () => {
  let executionCount = 0;
  const controller = new WorkbenchShellController({
    readConfiguration: async () => ({ config: {} }),
    executor: {
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
  const executions: CodexExecRequest[] = [];
  const environment = Object.freeze({ WORKBENCH_THREAD_ID: "stale-workbench", CODEX_THREAD_ID: "stale-native", WORKBENCH_HARNESS: "opencode" });
  const controller = new WorkbenchShellController({
    platform,
    shellEnvironment: environment,
    readConfiguration: async () => ({ config: {} }),
    executor: { execute: async (request) => {
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
    assert.equal(execution.cwd, path.resolve(workspace, "child"));
  }
  assert.equal(environment.WORKBENCH_THREAD_ID, "stale-workbench");
  assert.equal(environment.CODEX_THREAD_ID, "stale-native");
});

test("external enforcement becomes locally enforced read-only permissions and keeps configured environment restrictions", async () => {
  const calls: CodexExecRequest[] = [];
  const controller = new WorkbenchShellController({
    executor: { execute: async request => { calls.push(request); return { exitCode: 0, stdout: "", stderr: "" }; } },
    readConfiguration: async () => ({ config: {
      windows: { sandbox: "unelevated", sandbox_private_desktop: false },
      shell_environment_policy: {
        inherit: "core", ignore_default_excludes: false, filters: { "SECRET*": "exclude", "PATH": "include" }, set: { SAFE: "value" },
      },
    } }),
  });
  await controller.execute({ command: "read" }, sandboxMeta(process.cwd(), { type: "external", network: "enabled" }), new AbortController().signal, caller);
  assert.deepEqual(calls[0]?.permissions, {
    type: "managed", network: "restricted",
    file_system: { type: "restricted", entries: [{ access: "read", path: { type: "special", value: { kind: "root" } } }] },
  });
  assert.equal(calls[0]?.windowsSandboxLevel, "restricted-token");
  assert.equal(calls[0]?.windowsSandboxPrivateDesktop, false);
  assert.deepEqual(calls[0]?.envPolicy, {
    inherit: "core", ignoreDefaultExcludes: false, exclude: ["SECRET*"], includeOnly: ["PATH"], set: { SAFE: "value" },
  });
});

test("admitted non-Codex calls use their own WB identity and only admitted permissions", async () => {
  const calls: CodexExecRequest[] = [];
  const controller = new WorkbenchShellController({
    executor: { execute: async request => { calls.push(request); return { exitCode: 0, stdout: "", stderr: "" }; } },
    readConfiguration: async () => ({ config: { windows: { sandbox: "elevated" } } }),
  });
  const input = {
    caller: { harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("other"), cwd: process.cwd() },
    command: ["echo"], cwd: process.cwd(),
    permissions: { mode: "restricted" as const, writableRoots: [process.cwd()], network: false },
  };
  await controller.executeAdmitted(input, new AbortController().signal);
  await controller.executeAdmitted({ ...input, permissions: { mode: "approved-unrestricted" } }, new AbortController().signal);
  assert.equal(calls[0]?.permissions.type, "managed");
  assert.equal(calls[1]?.permissions.type, "disabled");
  assert.deepEqual(calls[0]?.env, { CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: "other", WORKBENCH_HARNESS: "opencode" });
});
