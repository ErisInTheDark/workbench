/*
 * Exports:
 * - ProcessSpec/RunningProcess: small process manager contracts for orchestrator child processes. Keywords: process, restart, child.
 * - log/logError: tagged stdout and stderr logging for orchestrator modules. Keywords: logging, orchestrator.
 * - appendCopilotEventLog: persist raw Copilot session events as JSONL for bridge debugging. Keywords: copilot, debug, events, jsonl.
 * - pipeChildStream/getSpawnDescriptor/createSpawnOptions/killProcessTree/killProcessTreeAsync: platform-safe process helpers for spawned child processes. Keywords: windows, spawn, shutdown, async, timeout.
 * - ProcessTreeRetirementOptions: platform and termination-command ports for owned process retirement.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnOptionsWithoutStdio } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { SessionEvent } from "@github/copilot-sdk";
import LinuxProcessGroupRetirement from "./LinuxProcessGroupRetirement";

const COPILOT_EVENT_LOG_MAX_STRING_LENGTH = 1024;
const ASYNC_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000;

export type ProcessSpec = {
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

export type RunningProcess = {
  child: import("node:child_process").ChildProcess | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
};

export function log(name: string, message: string) {
  process.stdout.write(`[${name}] ${message}\n`);
}

export function logError(name: string, message: string) {
  process.stderr.write(`[${name}] ${message}\n`);
}

export async function appendCopilotEventLog(
  projectRoot: string,
  sessionId: string,
  source: "history" | "live",
  event: SessionEvent,
) {
  const debugDir = path.join(projectRoot, ".debug", "copilot-events");
  const logFilePath = path.join(debugDir, `${sessionId}.jsonl`);
  const record = {
    event,
    loggedAt: new Date().toISOString(),
    sessionId,
    source,
  };

  try {
    await mkdir(debugDir, { recursive: true });
    await appendFile(logFilePath, `${JSON.stringify(record, (_key, value) => {
      if (typeof value === "string" && value.length > COPILOT_EVENT_LOG_MAX_STRING_LENGTH) {
        return `<content clipped (${value.length} chars)>`;
      }

      return value;
    })}\n`, "utf8");
  } catch (error) {
    logError("copilot-debug", error instanceof Error ? error.message : String(error));
  }
}

export function pipeChildStream(
  name: string,
  stream: NodeJS.ReadableStream | null | undefined,
  write: (chunk: Buffer) => void,
) {
  if (!stream) {
    return;
  }

  stream.on("data", (chunk: Buffer) => {
    write(chunk);
  });

  stream.on("error", (error) => {
    logError(name, error instanceof Error ? error.message : String(error));
  });
}

const WINDOWS_COMMAND_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/gu;

function escapeWindowsCommand(part: string) {
  return part.replace(WINDOWS_COMMAND_META_CHARACTERS, "^$1");
}

function escapeWindowsCommandArgument(part: string) {
  const escapedQuotes = part
    .replace(/(?=(\\+?)?)\1"/gu, "$1$1\\\"")
    .replace(/(?=(\\+?)?)\1$/u, "$1$1");
  return `"${escapedQuotes}"`.replace(WINDOWS_COMMAND_META_CHARACTERS, "^$1");
}

export function getSpawnDescriptor(spec: Pick<ProcessSpec, "args" | "command">) {
  if (process.platform !== "win32") {
    return {
      args: spec.args,
      command: spec.command,
    };
  }

  const commandLine = [escapeWindowsCommand(spec.command), ...spec.args.map(escapeWindowsCommandArgument)].join(" ");

  return {
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    command: process.env.ComSpec ?? "cmd.exe",
  };
}

export function createSpawnOptions(
  cwd: string,
  env: NodeJS.ProcessEnv,
  windowsHide: boolean,
): SpawnOptionsWithoutStdio {
  return {
    cwd,
    detached: process.platform !== "win32",
    env,
    windowsHide,
    ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
  };
}

export function killProcessTree(pid: number | undefined) {
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Best effort during shutdown.
  }
}

export interface ProcessTreeRetirementOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export async function killProcessTreeAsync(pid: number | undefined, options: ProcessTreeRetirementOptions = {}) {
  if (!pid) return;
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("A valid owned process is required.");
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    await new LinuxProcessGroupRetirement().retire(pid);
    return;
  }
  if (platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)("pwsh", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference = 'Stop'; $owned = [System.Diagnostics.Process]::GetProcessById(${pid}); $owned.Kill($true); $owned.WaitForExit()`,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-1000); };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("error", failed);
      child.removeListener("exit", exited);
      child.stdout?.removeListener("data", capture);
      child.stderr?.removeListener("data", capture);
      if (error) reject(error);
      else resolve();
    };
    const failed = (error: Error) => finish(error);
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code === 0 ? undefined : new Error(`Owned process termination failed (exit ${code}, signal ${signal}): ${output.replace(/\s+/gu, " ").trim()}`));
    };
    const timer = setTimeout(() => {
      try { child.kill(); }
      catch (error) {
        finish(new AggregateError([error], "Owned process termination command could not be stopped."));
        return;
      }
      finish(new Error(`Owned process termination did not finish within ${ASYNC_PROCESS_TREE_KILL_TIMEOUT_MS}ms.`));
    }, ASYNC_PROCESS_TREE_KILL_TIMEOUT_MS);
    child.once("error", failed);
    child.once("exit", exited);
  });
}
