/*
 * Exports:
 * - ProcessSpec/RunningProcess: small process manager contracts for orchestrator child processes. Keywords: process, restart, child.
 * - log/logError: tagged stdout and stderr logging for orchestrator modules. Keywords: logging, orchestrator.
 * - appendCopilotEventLog: persist raw Copilot session events as JSONL for bridge debugging. Keywords: copilot, debug, events, jsonl.
 * - pipeChildStream/getSpawnDescriptor/createSpawnOptions/killProcessTree: platform-safe process helpers for spawned child processes. Keywords: windows, spawn, shutdown.
 */
import { spawnSync, type SpawnOptionsWithoutStdio } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { SessionEvent } from "@github/copilot-sdk";

const COPILOT_EVENT_LOG_MAX_STRING_LENGTH = 1024;

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

function quoteWindowsCommandPart(part: string) {
  if (!part.length) {
    return '""';
  }

  if (!/[\s"]/u.test(part)) {
    return part;
  }

  return `"${part.replace(/"/g, '\\"')}"`;
}

export function getSpawnDescriptor(spec: Pick<ProcessSpec, "args" | "command">) {
  if (process.platform !== "win32") {
    return {
      args: spec.args,
      command: spec.command,
    };
  }

  const commandLine = [spec.command, ...spec.args]
    .map((part) => quoteWindowsCommandPart(part))
    .join(" ");

  return {
    args: ["/d", "/s", "/c", commandLine],
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