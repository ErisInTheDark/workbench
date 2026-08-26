/*
 * Exports:
 * - WORKBENCH_SHELL_SANDBOX_CAPABILITY/WORKBENCH_SHELL_TOOL_DESCRIPTION: advertise the MCP-only sandbox metadata and behavior contract. Keywords: workbench, shell, MCP, sandbox.
 * - WorkbenchShellControllerOptions: inject Codex execution and host command resolution. Keywords: workbench, shell, options, test.
 * - default WorkbenchShellController: run host-shell commands through Codex's exact MCP sandbox state. Keywords: workbench, shell, Codex, sandbox.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { z } from "zod";

import type { JsonValue } from "../lib/workbench/commands/workbench-agent-command-definition";
import { WorkbenchShellInputSchema } from "../lib/workbench/commands/workbench-shell-command";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import CodexCommandExecController from "./CodexCommandExecController";
import { getSpawnDescriptor } from "./process-helpers";

export const WORKBENCH_SHELL_SANDBOX_CAPABILITY = "codex/sandbox-state-meta";
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
  commandExec?: Pick<CodexCommandExecController, "execute">;
  getCodexSpawnDescriptor?: typeof getSpawnDescriptor;
  platform?: NodeJS.Platform;
  requestCodex?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
  shellEnvironment?: NodeJS.ProcessEnv;
}

function readSandboxState(meta: Record<string, unknown> | undefined) {
  const result = SandboxStateSchema.safeParse(meta?.[WORKBENCH_SHELL_SANDBOX_CAPABILITY]);
  if (!result.success) throw new Error("Codex did not provide valid MCP sandbox state.");
  return result.data;
}

function hostShellCommand(command: string, login: boolean, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) {
  if (platform === "win32") {
    return ["pwsh", ...(login ? [] : ["-NoProfile"]), "-Command", command];
  }
  return [environment.SHELL?.trim() || "/bin/sh", login ? "-lc" : "-c", command];
}

export default class WorkbenchShellController {
  private readonly commandExec: Pick<CodexCommandExecController, "execute">;
  private readonly getCodexSpawnDescriptor: typeof getSpawnDescriptor;
  private readonly platform: NodeJS.Platform;
  private readonly shellEnvironment: NodeJS.ProcessEnv;

  constructor({ commandExec, getCodexSpawnDescriptor = getSpawnDescriptor, platform = process.platform, requestCodex, shellEnvironment = process.env }: WorkbenchShellControllerOptions) {
    if (!commandExec && !requestCodex) throw new Error("Codex command execution is not configured.");
    this.commandExec = commandExec ?? new CodexCommandExecController({ requestCodex: requestCodex! });
    this.getCodexSpawnDescriptor = getCodexSpawnDescriptor;
    this.platform = platform;
    this.shellEnvironment = shellEnvironment;
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
    const descriptor = this.getCodexSpawnDescriptor({
      command: "codex",
      args: ["sandbox", "--sandbox-state-json", JSON.stringify(commandState), "--", ...shellCommand],
    });

    const result = await this.commandExec.execute({
      command: [descriptor.command, ...descriptor.args],
      cwd: commandCwd,
      sandboxPolicy: { type: "dangerFullAccess" },
      ...(request.timeout_ms === undefined ? {} : { timeoutMs: request.timeout_ms }),
    }, signal);
    return { ...result, cwd: commandCwd };
  }
}
