/*
 * No exports. Tests protect caller isolation, sandbox forwarding and permission-safe prepared execution.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import type { CodexExecRequest } from "./codex-exec-protocol";
import WorkbenchShellController from "./CodexShellController";
import type { WorkbenchShellRun } from "./provider-execution";
import { WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";

const caller = { nativeThreadId: "native-session", workbenchThreadId: "workbench-thread" };
const unusedExecutor = { execute: async (): Promise<never> => { throw new Error("prepared shells never run here"); } };

function sandboxed(run: WorkbenchShellRun): CodexExecRequest {
  assert.equal(run.kind, "sandboxed");
  return run.request as CodexExecRequest;
}

test("shell prepares sandbox permissions for the persistent executor rather than launching another Codex process", async () => {
  const controller = new WorkbenchShellController({
    platform: "linux",
    shellEnvironment: { SHELL: "/bin/bash" },
    readConfiguration: async () => ({ config: {} }),
    executor: unusedExecutor,
  });
  const prepared = await controller.prepare({ command: "printf ok" }, sandboxMeta(process.cwd()), new AbortController().signal, caller);
  assert.equal(sandboxed(prepared.run).command[0], "/bin/bash", "prepare the requested shell for the persistent sandbox owner");
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
  const workspace = path.resolve("C:/workspace");
  const permissionProfile = {
    file_system: {
      entries: [{ access: "write", path: { type: "path", path: workspace } }],
      type: "restricted",
    },
    type: "managed",
  };
  const controller = new WorkbenchShellController({
    readConfiguration: async () => ({ config: {
      features: { code_mode: { enabled: true }, elevated_windows_sandbox: true, network_proxy: null },
      windows: { sandbox: "elevated" },
    } }),
    executor: unusedExecutor,
    platform: "win32",
  });

  const prepared = await controller.prepare({
    command: "Get-Content 'quoted file.txt'",
    login: false,
    timeout_ms: 4321,
    workdir: "child",
  }, sandboxMeta(workspace, permissionProfile), new AbortController().signal, caller);

  assert.equal(prepared.cwd, path.resolve(workspace, "child"));
  assert.equal(prepared.shell, "pwsh");
  const execution = sandboxed(prepared.run);
  assert.equal(execution.cwd, path.resolve(workspace, "child"));
  assert.equal(execution.timeoutMs, 4321);
  assert.deepEqual(execution.permissions, {
    ...permissionProfile,
    file_system: {
      ...permissionProfile.file_system,
      entries: [{ access: "write", path: { type: "path", path: pathToFileURL(workspace).href } }],
    },
    network: "restricted",
  });
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
  const workspace = path.resolve("C:/workspace");
  const controller = new WorkbenchShellController({
    readConfiguration: async () => ({ config: {} }),
    executor: unusedExecutor,
    platform: "linux",
    shellEnvironment: { NODE_ENV: "test", SHELL: "/bin/bash" },
  });

  const prepared = await controller.prepare({
    command: "printf '%s' 'quoted value'",
    login: false,
  }, sandboxMeta(workspace), new AbortController().signal, caller);

  assert.equal(prepared.shell, "bash");
  const execution = sandboxed(prepared.run);
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
  const controller = new WorkbenchShellController({
    readConfiguration: async () => ({ config: {} }),
    executor: unusedExecutor,
  });

  await assert.rejects(
    controller.prepare({ command: "echo safe" }, { threadId: "thread-1" }, new AbortController().signal, caller),
    /valid MCP sandbox state \(missing capability\)/u,
  );
});

test("rejects relative native permission paths instead of resolving them against Workbench", async () => {
  const controller = new WorkbenchShellController({
    readConfiguration: async () => ({ config: {} }),
    executor: unusedExecutor,
  });
  const permissionProfile = {
    file_system: {
      entries: [{ access: "write", path: { type: "path", path: "relative-root" } }],
      type: "restricted",
    },
    type: "managed",
  };
  await assert.rejects(
    controller.prepare({ command: "echo unsafe" }, sandboxMeta(process.cwd(), permissionProfile), new AbortController().signal, caller),
    /permissionProfile\.file_system\.entries\.0\.path\.path: custom/u,
  );
});

for (const platform of ["win32", "linux"] as const) test(`shell installs distinct caller identities without leaking between calls on ${platform}`, async () => {
  const workspace = path.resolve("C:/workspace");
  const executions: CodexExecRequest[] = [];
  const environment = Object.freeze({ WORKBENCH_THREAD_ID: "stale-workbench", CODEX_THREAD_ID: "stale-native", WORKBENCH_HARNESS: "opencode" });
  const controller = new WorkbenchShellController({
    platform,
    shellEnvironment: environment,
    readConfiguration: async () => ({ config: {} }),
    executor: unusedExecutor,
  });
  const callers = [
    { nativeThreadId: "native-first", workbenchThreadId: "workbench-first" },
    { nativeThreadId: "native-second", workbenchThreadId: "workbench-second" },
  ];
  for (const caller of callers) {
    const prepared = await controller.prepare({ command: "echo safe", workdir: "child" },
      sandboxMeta(workspace), new AbortController().signal, caller);
    executions.push(sandboxed(prepared.run));
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
  const controller = new WorkbenchShellController({
    executor: unusedExecutor,
    readConfiguration: async () => ({ config: {
      windows: { sandbox: "unelevated", sandbox_private_desktop: false },
      shell_environment_policy: {
        inherit: "core", ignore_default_excludes: false, filters: { "SECRET*": "exclude", "PATH": "include" }, set: { SAFE: "value" },
      },
    } }),
  });
  const prepared = await controller.prepare({ command: "read" }, sandboxMeta(process.cwd(), { type: "external", network: "enabled" }), new AbortController().signal, caller);
  const execution = sandboxed(prepared.run);
  assert.deepEqual(execution.permissions, {
    type: "managed", network: "restricted",
    file_system: { type: "restricted", entries: [{ access: "read", path: { type: "special", value: { kind: "root" } } }] },
  });
  assert.equal(execution.windowsSandboxLevel, "restricted-token");
  assert.equal(execution.windowsSandboxPrivateDesktop, false);
  assert.deepEqual(execution.envPolicy, {
    inherit: "core", ignoreDefaultExcludes: false, exclude: ["SECRET*"], includeOnly: ["PATH"], set: { SAFE: "value" },
  });
});

test("admitted non-Codex calls use their own WB identity and only admitted permissions", async () => {
  const controller = new WorkbenchShellController({
    executor: unusedExecutor,
    readConfiguration: async () => ({ config: { windows: { sandbox: "elevated" } } }),
    platform: "win32",
  });
  const input = {
    caller: { harness: "opencode", threadId: WorkbenchThreadIdSchema.parse("other"), cwd: process.cwd() },
    command: ["echo"], cwd: process.cwd(),
    permissions: { mode: "restricted" as const, writableRoots: [process.cwd()], network: false },
  };
  const restricted = sandboxed(await controller.prepareAdmitted(input, new AbortController().signal));
  const approved = await controller.prepareAdmitted({ ...input, permissions: { mode: "approved-unrestricted" } }, new AbortController().signal);
  assert.equal(restricted.permissions.type, "managed");
  assert.deepEqual(restricted.env, { CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: "other", WORKBENCH_HARNESS: "opencode" });
  assert.ok(approved.kind === "approved");
  assert.equal(approved.request.caller.threadId, "other");
});

test("commands marked expensive on every route are prepared for a machine-wide slot; others never wait", async () => {
  const controller = new WorkbenchShellController({
    platform: "linux",
    shellEnvironment: { SHELL: "/bin/bash" },
    readConfiguration: async () => ({ config: {} }),
    executor: unusedExecutor,
  });
  const signal = new AbortController().signal;
  const runs = [
    (await controller.prepare({ command: "cargo build --release", expensive: true }, sandboxMeta(process.cwd()), signal, caller)).run,
    (await controller.prepare({ command: "cargo build --release" }, sandboxMeta(process.cwd()), signal, caller)).run,
    (await controller.prepare({ command: "git status", expensive: true }, sandboxMeta(process.cwd()), signal, caller)).run,
    await controller.prepareAdmitted({
      caller: { harness: "claude", threadId: WorkbenchThreadIdSchema.parse("other"), cwd: process.cwd() },
      command: ["pnpm", "test"], cwd: process.cwd(), expensive: true,
      permissions: { mode: "restricted", writableRoots: [process.cwd()], network: false },
    }, signal),
  ];
  assert.deepEqual(runs.filter(run => run.expensive).map(run => run.label), ["cargo build --release", "git status", "pnpm test"]);
});
