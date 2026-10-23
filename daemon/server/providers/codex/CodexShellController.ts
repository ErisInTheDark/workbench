/*
 * Exports:
 * - WORKBENCH_SHELL_TOOL_DESCRIPTION: the shell tool's behavior contract.
 * - CodexShellControllerOptions: inject Codex configuration, sandbox ACL repair, host environment and managed pwsh.
 * - default CodexShellController: prepare Workbench-admitted commands in the Codex sandbox; the exec node runs them.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

import { z } from "zod";

import type { WorkbenchAdmittedExecution, WorkbenchShellRun } from "../provider-execution";
import type CodexExecServer from "./CodexExecServer";
import type CodexSandboxAclController from "./CodexSandboxAclController";
import type { CodexSandboxAclCommandRunner } from "./CodexSandboxAclController";
import type { CodexExecPermission, CodexExecRequest } from "./codex-exec-protocol";

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

export const WORKBENCH_SHELL_TOOL_DESCRIPTION = "Run a shell command in the sandbox, or request approval to run it outside the sandbox.";

export interface CodexShellControllerOptions {
  /** Runs only the short sandbox ACL repair commands; agent commands run through the exec node's shell runner. */
  executor: Pick<CodexExecServer, "execute">;
  /** Background repair of Windows sandbox write ACEs that never reached existing files. */
  sandboxAcl?: Pick<CodexSandboxAclController, "checkInBackground">;
  readConfiguration(cwd: string): Promise<unknown>;
  platform?: NodeJS.Platform;
  powerShellExecutable?(): Promise<string>;
}

export default class CodexShellController {
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: CodexShellControllerOptions) {
    this.platform = options.platform ?? process.platform;
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

  /** Run argv as the Codex sandbox identity with only `root` writable; ACL repair needs the owner of sandbox-created objects. */
  readonly runSandboxed: CodexSandboxAclCommandRunner = async (command, root, signal) => {
    const configuration = await this.configuration(root);
    signal.throwIfAborted();
    const result = await this.options.executor.execute({
      ...configuration, command, cwd: root, workspaceRoots: [root],
      permissions: {
        type: "managed", network: "restricted",
        file_system: {
          type: "restricted",
          entries: [
            { access: "read", path: { type: "special", value: { kind: "root" } } },
            { access: "write", path: { type: "path", path: pathToFileURL(root).href } },
          ],
        },
      },
      env: { CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: "", WORKBENCH_HARNESS: "" },
    }, signal);
    return { code: result.exitCode, stdout: result.stdout };
  };

  async prepareAdmitted(request: WorkbenchAdmittedExecution, signal: AbortSignal): Promise<WorkbenchShellRun> {
    const label = request.command.join(" ");
    const expensive = request.expensive === true;
    const command = this.platform === "win32"
      && /^pwsh(?:\.exe)?$/iu.test(path.basename(request.command[0] ?? ""))
      ? [await (this.options.powerShellExecutable ?? (async () => "pwsh"))(), ...request.command.slice(1)]
      : request.command;
    if (request.permissions.mode !== "approved-unrestricted") this.options.sandboxAcl?.checkInBackground(request.cwd, this.runSandboxed);
    const configuration = await this.configuration(request.cwd);
    signal.throwIfAborted();
    if (request.permissions.mode === "approved-unrestricted" && this.platform === "win32") {
      const policy = configuration.envPolicy;
      if (policy.inherit !== "all" || !policy.ignoreDefaultExcludes || policy.exclude.length
        || policy.includeOnly.length || Object.keys(policy.set).length) {
        throw new Error("Outside-sandbox execution cannot bypass the configured shell environment policy.");
      }
      return { kind: "approved", label, expensive, request: { ...request, permissions: request.permissions } };
    }
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
    return {
      kind: "sandboxed", label, expensive,
      request: {
        ...configuration, command, cwd: request.cwd, permissions,
        workspaceRoots: [request.caller.cwd], timeoutMs: request.timeoutMs,
        env: { CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: request.caller.threadId, WORKBENCH_HARNESS: request.caller.harness },
      },
    };
  }
}
