/*
 * Exports:
 * - hostShellCommand: wrap one command string in the host's shell argv (pwsh on Windows, $SHELL elsewhere).
 * - prepareWorkbenchShellExecution: translate escalating shell input into one admitted host-shell command.
 */
import path from "node:path";

import {
  WorkbenchEscalatingShellInputSchema,
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

export function hostShellCommand(
  command: string,
  login: boolean,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  powerShellExecutable = "pwsh",
) {
  if (platform === "win32") {
    return {
      command: [powerShellExecutable, ...(login ? [] : ["-NoProfile"]), "-Command", command],
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
  const request = WorkbenchEscalatingShellInputSchema.parse(input);
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
