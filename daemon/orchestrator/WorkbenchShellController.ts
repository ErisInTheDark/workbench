/*
 * Exports:
 * - WORKBENCH_SHELL_SANDBOX_CAPABILITY/WORKBENCH_SHELL_TOOL_DESCRIPTION: advertise the MCP-only sandbox metadata and behavior contract. Keywords: workbench, shell, MCP, sandbox.
 * - WorkbenchShellControllerOptions: inject Codex execution and host environment. Keywords: workbench, shell, options, test.
 * - default WorkbenchShellController: run host-shell commands through the Codex thread's exact sandbox state. Keywords: workbench, shell, Codex, sandbox.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { z } from "zod";

import type { JsonValue } from "../lib/workbench/commands/workbench-agent-command-definition";
import {
  WorkbenchShellInputSchema,
  type WorkbenchShell,
} from "workbench-shared/workbench/commands/workbench-shell-command";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import CodexCommandExecController from "./CodexCommandExecController";

export const WORKBENCH_SHELL_SANDBOX_CAPABILITY = "codex/sandbox-state-meta";
const WINDOWS_CODEX_ARGS_ENV = "WORKBENCH_CODEX_SANDBOX_ARGS_JSON";
const WINDOWS_CODEX_LAUNCH_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  `$raw = [Environment]::GetEnvironmentVariable("${WINDOWS_CODEX_ARGS_ENV}", "Process")`,
  `[Environment]::SetEnvironmentVariable("${WINDOWS_CODEX_ARGS_ENV}", $null, "Process")`,
  "[string[]]$codexArgs = ConvertFrom-Json -InputObject $raw",
  "& (Get-Command codex -CommandType ExternalScript -ErrorAction Stop).Source @codexArgs",
  "exit $LASTEXITCODE",
].join("; ");
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.null(),
  z.array(JsonValueSchema),
  z.record(z.string(), JsonValueSchema),
]));
const SandboxStateSchema = z.object({
  codexLinuxSandboxExe: z.string().nullable(),
  permissionProfile: z.record(z.string(), JsonValueSchema),
  sandboxCwd: z.string().url().refine((value) => new URL(value).protocol === "file:", "sandboxCwd must be a file URL"),
  useLegacyLandlock: z.boolean().optional(),
});

export const WORKBENCH_SHELL_TOOL_DESCRIPTION = "Run a shell command inside the current Codex turn sandbox. This tool never escalates or opens an approval prompt. If a necessary command fails because the sandbox blocked it, diagnose that restriction before retrying with the direct shell_command tool and require_escalated.";

export interface WorkbenchShellControllerOptions {
  resolveThreadId?: (nativeThreadId: string, cwd: string) => Promise<string>;
  commandExec?: Pick<CodexCommandExecController, "execute">;
  platform?: NodeJS.Platform;
  requestCodex?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  shellEnvironment?: NodeJS.ProcessEnv;
}

function readSandboxState(meta: Record<string, unknown> | undefined) {
  const result = SandboxStateSchema.safeParse(meta?.[WORKBENCH_SHELL_SANDBOX_CAPABILITY]);
  if (!result.success) throw new Error("Codex did not provide valid MCP sandbox state.");
  return result.data;
}

function readPosixShell(executable: string): WorkbenchShell {
  const shell = path.basename(executable).toLowerCase();
  switch (shell) {
    case "bash":
    case "fish":
    case "sh":
    case "zsh":
      return shell;
    default:
      return "shell";
  }
}

function hostShellCommand(command: string, login: boolean, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) {
  if (platform === "win32") {
    return {
      command: ["pwsh", ...(login ? [] : ["-NoProfile"]), "-Command", command],
      shell: "pwsh" as const,
    };
  }
  const executable = environment.SHELL?.trim() || "/bin/sh";
  return {
    command: [executable, login ? "-lc" : "-c", command],
    shell: readPosixShell(executable),
  };
}

function codexSandboxLaunch(codexArgs: string[], platform: NodeJS.Platform) {
  if (platform !== "win32") return { command: ["codex", ...codexArgs] };
  return {
    command: ["pwsh", "-NoProfile", "-Command", WINDOWS_CODEX_LAUNCH_SCRIPT],
    env: { [WINDOWS_CODEX_ARGS_ENV]: JSON.stringify(codexArgs) },
  };
}

export default class WorkbenchShellController {
  private readonly commandExec: Pick<CodexCommandExecController, "execute">;
  private readonly platform: NodeJS.Platform;
  private readonly shellEnvironment: NodeJS.ProcessEnv;
  private readonly resolveThreadId: WorkbenchShellControllerOptions["resolveThreadId"];

  constructor({ commandExec, platform = process.platform, requestCodex, resolveThreadId, shellEnvironment = process.env }: WorkbenchShellControllerOptions) {
    if (!commandExec && !requestCodex) throw new Error("Codex command execution is not configured.");
    this.commandExec = commandExec ?? new CodexCommandExecController({ requestCodex: requestCodex! });
    this.platform = platform;
    this.shellEnvironment = shellEnvironment;
    this.resolveThreadId = resolveThreadId;
  }

  async execute(input: object, meta: Record<string, unknown> | undefined, signal: AbortSignal) {
    const request = WorkbenchShellInputSchema.parse(input);
    const sandboxState = readSandboxState(meta);
    const sandboxCwd = fileURLToPath(sandboxState.sandboxCwd);
    const commandCwd = request.workdir ? path.resolve(sandboxCwd, request.workdir) : sandboxCwd;
    const commandState = {
      ...sandboxState,
      sandboxCwd: pathToFileURL(commandCwd).toString(),
    };
    const shellCommand = hostShellCommand(
      request.command,
      request.login ?? true,
      this.platform,
      this.shellEnvironment,
    );
    const launch = codexSandboxLaunch([
      "sandbox",
      "--sandbox-state-json",
      JSON.stringify(commandState),
      "--",
      ...shellCommand.command,
    ], this.platform);
    const nativeThreadId = typeof meta?.threadId === "string" ? meta.threadId : "";
    if (this.resolveThreadId && !nativeThreadId) throw new Error("Codex did not provide trusted MCP thread identity.");
    const threadId = this.resolveThreadId ? await this.resolveThreadId(nativeThreadId, sandboxCwd) : null;

    const result = await this.commandExec.execute({
      ...launch,
      ...(threadId ? { env: { ...launch.env, WORKBENCH_THREAD_ID: threadId, WORKBENCH_HARNESS: "codex" } } : {}),
      cwd: commandCwd,
      sandboxPolicy: { type: "dangerFullAccess" },
      ...(request.timeout_ms === undefined ? {} : { timeoutMs: request.timeout_ms }),
    }, signal);
    return { ...result, cwd: commandCwd, shell: shellCommand.shell };
  }
}
