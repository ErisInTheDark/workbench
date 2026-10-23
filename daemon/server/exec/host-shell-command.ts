/*
 * Exports:
 * - prepareWorkbenchShellExecution: translate shell tool input into one host-shell command for Workbench admission
 *   (pwsh on Windows, $SHELL elsewhere).
 */
import path from "node:path";

import {
  WorkbenchShellInputSchema,
  type WorkbenchShell,
} from "workbench-shared/workbench/commands/workbench-shell-command";

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

/** Windows names plain `pwsh`; the provider's sandbox preparation substitutes its managed executable. */
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

export function prepareWorkbenchShellExecution(
  input: object,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const request = WorkbenchShellInputSchema.parse(input);
  const commandCwd = request.workdir ? path.resolve(cwd, request.workdir) : cwd;
  const shell = hostShellCommand(request.command, request.login ?? true, platform, environment);
  return {
    command: shell.command,
    cwd: commandCwd,
    shell: shell.shell,
    outsideSandbox: request.outside_sandbox === true,
    ...(request.justification === undefined ? {} : { justification: request.justification }),
    ...(request.timeout_ms === undefined ? {} : { timeoutMs: request.timeout_ms }),
    ...(request.expensive ? { expensive: true } : {}),
  };
}
