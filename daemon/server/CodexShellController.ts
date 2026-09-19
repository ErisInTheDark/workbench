/*
 * Exports:
 * - WORKBENCH_SHELL_SANDBOX_CAPABILITY/WORKBENCH_SHELL_TOOL_DESCRIPTION: advertise the MCP-only sandbox metadata and behavior contract.
 * - CodexShellControllerOptions: inject Codex execution and host environment.
 * - default CodexShellController: run host-shell commands through the Codex thread's exact sandbox state.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { z } from "zod";

import {
  WorkbenchShellInputSchema,
  type WorkbenchShell,
} from "workbench-shared/workbench/commands/workbench-shell-command";
import type { WorkbenchAdmittedExecution } from "workbench-shared/workbench/provider/provider-execution";
import type CodexExecServer from "./CodexExecServer";
import { CodexExecPermissionSchema, type CodexExecPermission, type CodexExecRequest } from "./codex-exec-protocol";

export const WORKBENCH_SHELL_SANDBOX_CAPABILITY = "codex/sandbox-state-meta";
function normalizeSandboxPermissionProfile(value: unknown) {
  if (typeof value !== "object" || value === null) return value;
  const profile = { ...value } as Record<string, unknown>;
  if (
    (profile.type === "managed" || profile.type === "external")
    && !("network" in profile)
  ) profile.network = "restricted";
  if (profile.type !== "managed" || typeof profile.file_system !== "object" || profile.file_system === null) return profile;
  const fileSystem = profile.file_system as Record<string, unknown>;
  if (fileSystem.type !== "restricted" || !Array.isArray(fileSystem.entries)) return profile;
  profile.file_system = {
    ...fileSystem,
    entries: fileSystem.entries.map((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) return entry;
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.path !== "object" || candidate.path === null) return entry;
      const permissionPath = candidate.path as Record<string, unknown>;
      if (permissionPath.type !== "path" || typeof permissionPath.path !== "string" || !path.isAbsolute(permissionPath.path)) return entry;
      return { ...candidate, path: { ...permissionPath, path: pathToFileURL(permissionPath.path).href } };
    }),
  };
  return profile;
}
const SandboxPermissionProfileSchema = z.preprocess((value) => {
  return normalizeSandboxPermissionProfile(value);
}, CodexExecPermissionSchema);
const SandboxStateSchema = z.object({
  permissionProfile: SandboxPermissionProfileSchema,
  sandboxCwd: z.string().url().refine((value) => new URL(value).protocol === "file:", "sandboxCwd must be a file URL"),
  useLegacyLandlock: z.boolean().optional(),
});
const configurationSchema = z.object({
  config: z.object({
    windows: z.object({
      sandbox: z.enum(["elevated", "unelevated"]).nullish(),
      sandbox_private_desktop: z.boolean().nullish(),
    }).nullish(),
    features: z.object({
      elevated_windows_sandbox: z.boolean().nullish(),
    }).passthrough().nullish(),
    shell_environment_policy: z.object({
      inherit: z.enum(["all", "core", "none"]).nullish(),
      ignore_default_excludes: z.boolean().nullish(),
      exclude: z.array(z.string()).nullish(),
      include_only: z.array(z.string()).nullish(),
      set: z.record(z.string(), z.string()).nullish(),
      filters: z.record(z.string(), z.enum(["include", "exclude"])).nullish(),
    }).nullish(),
  }),
});

export const WORKBENCH_SHELL_TOOL_DESCRIPTION = "Run a shell command inside the current Codex turn sandbox. This tool never escalates or opens an approval prompt. If a necessary command fails because the sandbox blocked it, diagnose that restriction before retrying with the direct shell_command tool and require_escalated.";

export interface CodexShellControllerOptions {
  executor: Pick<CodexExecServer, "execute">;
  readConfiguration(cwd: string): Promise<unknown>;
  platform?: NodeJS.Platform;
  shellEnvironment?: NodeJS.ProcessEnv;
}

function readSandboxState(meta: Record<string, unknown> | undefined) {
  const state = meta?.[WORKBENCH_SHELL_SANDBOX_CAPABILITY];
  const result = SandboxStateSchema.safeParse(state);
  if (!result.success) {
    const detail = state === undefined
      ? "missing capability"
      : result.error.issues.slice(0, 5).map(issue => (
        `${issue.path.length ? issue.path.join(".") : "root"}: ${issue.code}`
      )).join(", ");
    throw new Error(`Codex did not provide valid MCP sandbox state (${detail}).`);
  }
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

export default class CodexShellController {
  private readonly platform: NodeJS.Platform;
  private readonly shellEnvironment: NodeJS.ProcessEnv;

  constructor(private readonly options: CodexShellControllerOptions) {
    this.platform = options.platform ?? process.platform;
    this.shellEnvironment = options.shellEnvironment ?? process.env;
  }

  private async configuration(cwd: string) {
    const { config } = configurationSchema.parse(await this.options.readConfiguration(cwd));
    const features = config.features ?? {};
    const windowsSandboxLevel = config.windows?.sandbox === "elevated" ? "elevated"
      : config.windows?.sandbox === "unelevated" ? "restricted-token"
      : features.elevated_windows_sandbox ? "elevated" : "restricted-token";
    const policy = config.shell_environment_policy;
    const filters = policy?.filters ? Object.entries(policy.filters) : null;
    return {
      windowsSandboxLevel,
      windowsSandboxPrivateDesktop: config.windows?.sandbox_private_desktop ?? true,
      envPolicy: {
        inherit: policy?.inherit ?? "all",
        ignoreDefaultExcludes: policy?.ignore_default_excludes ?? true,
        exclude: filters ? filters.filter(([, action]) => action === "exclude").map(([pattern]) => pattern) : policy?.exclude ?? [],
        includeOnly: filters ? filters.filter(([, action]) => action === "include").map(([pattern]) => pattern) : policy?.include_only ?? [],
        set: policy?.set ?? {},
      },
    } satisfies Pick<CodexExecRequest, "windowsSandboxLevel" | "windowsSandboxPrivateDesktop" | "envPolicy">;
  }

  async execute(
    input: object,
    meta: Record<string, unknown> | undefined,
    signal: AbortSignal,
    caller: { nativeThreadId: string; workbenchThreadId: string },
  ) {
    const request = WorkbenchShellInputSchema.parse(input);
    const sandboxState = readSandboxState(meta);
    const sandboxCwd = fileURLToPath(sandboxState.sandboxCwd);
    const commandCwd = request.workdir ? path.resolve(sandboxCwd, request.workdir) : sandboxCwd;
    const shellCommand = hostShellCommand(
      request.command,
      request.login ?? true,
      this.platform,
      this.shellEnvironment,
    );
    // An external profile describes someone else's sandbox, not this process.
    const permissions: CodexExecPermission = sandboxState.permissionProfile.type === "external" ? {
      type: "managed", network: "restricted",
      file_system: { type: "restricted", entries: [{ access: "read", path: { type: "special", value: { kind: "root" } } }] },
    } : sandboxState.permissionProfile;
    const configuration = await this.configuration(commandCwd);
    signal.throwIfAborted();
    const result = await this.options.executor.execute({
      ...configuration,
      command: shellCommand.command,
      env: {
        CODEX_THREAD_ID: caller.nativeThreadId,
        WORKBENCH_THREAD_ID: caller.workbenchThreadId,
        WORKBENCH_HARNESS: "codex",
      },
      cwd: commandCwd,
      permissions,
      workspaceRoots: [sandboxCwd],
      useLegacyLandlock: sandboxState.useLegacyLandlock,
      ...(request.timeout_ms === undefined ? {} : { timeoutMs: request.timeout_ms }),
    }, signal);
    return { ...result, cwd: commandCwd, shell: shellCommand.shell };
  }

  async executeAdmitted(request: WorkbenchAdmittedExecution, signal: AbortSignal) {
    const configuration = await this.configuration(request.cwd);
    signal.throwIfAborted();
    const permissions: CodexExecPermission = request.permissions.mode === "approved-unrestricted"
      ? { type: "disabled" }
      : {
        type: "managed", network: request.permissions.network ? "enabled" : "restricted",
        file_system: {
          type: "restricted",
          entries: [
            { access: "read", path: { type: "special", value: { kind: "root" } } },
            ...request.permissions.writableRoots.map(root => ({
              access: "write" as const, path: { type: "path" as const, path: pathToFileURL(root).href },
            })),
          ],
        },
      };
    return this.options.executor.execute({
      ...configuration, command: request.command, cwd: request.cwd, permissions,
      workspaceRoots: [request.caller.cwd], timeoutMs: request.timeoutMs,
      env: { CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: request.caller.threadId, WORKBENCH_HARNESS: request.caller.harness },
    }, signal);
  }
}
