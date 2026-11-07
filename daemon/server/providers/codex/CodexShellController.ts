/*
 * Exports:
 * - WORKBENCH_SHELL_TOOL_DESCRIPTION: the shell tool's behavior contract.
 * - CodexShellControllerOptions: inject the Windows sandbox level, sandbox ACL repair, executor and managed pwsh.
 * - default CodexShellController: prepare Workbench-admitted commands in the Codex sandbox; the exec node runs them.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

import type { WorkbenchAdmittedExecution, WorkbenchShellRun } from "../provider-execution";
import type CodexExecServer from "./CodexExecServer";
import type CodexSandboxAclController from "./CodexSandboxAclController";
import type { CodexSandboxAclCommandRunner } from "./CodexSandboxAclController";
import type CodexWindowsSandbox from "./CodexWindowsSandbox";
import type { CodexExecPermission } from "./codex-exec-protocol";

export const WORKBENCH_SHELL_TOOL_DESCRIPTION = "Run a shell command in the sandbox, or request approval to run it outside the sandbox.";

export interface CodexShellControllerOptions {
  /** Runs only the short sandbox ACL repair commands; agent commands run through the exec node's shell runner. */
  executor: Pick<CodexExecServer, "execute">;
  /** Background repair of Windows sandbox write ACEs that never reached existing files. */
  sandboxAcl?: Pick<CodexSandboxAclController, "checkInBackground">;
  windowsSandbox: Pick<CodexWindowsSandbox, "level">;
  platform?: NodeJS.Platform;
  powerShellExecutable?(): Promise<string>;
}

export default class CodexShellController {
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: CodexShellControllerOptions) {
    this.platform = options.platform ?? process.platform;
  }

  /** Run argv as the Codex sandbox identity with only `root` writable; ACL repair needs the owner of sandbox-created objects. */
  readonly runSandboxed: CodexSandboxAclCommandRunner = async (command, root, signal) => {
    const windowsSandboxLevel = await this.options.windowsSandbox.level(root);
    signal.throwIfAborted();
    const result = await this.options.executor.execute({
      windowsSandboxLevel, command, cwd: root, workspaceRoots: [root],
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
    if (request.permissions.mode === "approved-unrestricted" && this.platform === "win32") {
      return { kind: "approved", label, expensive, request: { ...request, permissions: request.permissions } };
    }
    const command = this.platform === "win32"
      && /^pwsh(?:\.exe)?$/iu.test(path.basename(request.command[0] ?? ""))
      ? [await (this.options.powerShellExecutable ?? (async () => "pwsh"))(), ...request.command.slice(1)]
      : request.command;
    if (request.permissions.mode !== "approved-unrestricted") this.options.sandboxAcl?.checkInBackground(request.cwd, this.runSandboxed);
    const windowsSandboxLevel = await this.options.windowsSandbox.level(request.cwd);
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
    return {
      kind: "sandboxed", label, expensive,
      request: {
        windowsSandboxLevel, command, cwd: request.cwd, permissions,
        workspaceRoots: [request.caller.cwd], timeoutMs: request.timeoutMs,
        env: { CODEX_THREAD_ID: "", WORKBENCH_THREAD_ID: request.caller.threadId, WORKBENCH_HARNESS: request.caller.harness },
      },
    };
  }
}
