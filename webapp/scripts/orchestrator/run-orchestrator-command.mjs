/*
 * Exports:
 * - runOrchestratorCommand: own one orchestrator child process, merged formatted output, mirrored stdout/file sinks, exact child status, and immediate child-tree disposal on sink failure. Keywords: orchestrator, child, logging, sink, disposal.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { OrchestratorLogLineFormatter } from "./format-orchestrator-log-stream.mjs";

const LOGGING_FAILURE_EXIT_CODE = 74;
const RUNNER_FAILURE_EXIT_CODE = 70;
const DISPOSAL_COMMAND_TIMEOUT_MS = 5_000;
const DISPOSAL_EXIT_WAIT_MS = 2_000;

class LoggingSinkError extends Error {
  constructor(message, readonlyChildPid) {
    super(message);
    this.childPid = readonlyChildPid;
    this.name = "LoggingSinkError";
  }
}

class MirroredLogSink extends Writable {
  constructor(fileStream, stdout) {
    super();
    this.fileStream = fileStream;
    this.stdout = stdout;
    this.activeWriteFailure = null;
    this.onFileError = (error) => this.#fail(error);
    this.onStdoutError = (error) => this.#fail(error);
    this.fileStream.on("error", this.onFileError);
    this.stdout.on("error", this.onStdoutError);
  }

  _write(chunk, _encoding, callback) {
    let pending = 2;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      if (error) {
        settled = true;
        this.activeWriteFailure = null;
        callback(error);
        return;
      }
      pending -= 1;
      if (pending === 0) {
        settled = true;
        this.activeWriteFailure = null;
        callback();
      }
    };
    this.activeWriteFailure = (error) => finish(error);
    this.#write(this.stdout, chunk, finish);
    this.#write(this.fileStream, chunk, finish);
  }

  _final(callback) {
    this.fileStream.end();
    Promise.race([
      once(this.fileStream, "finish"),
      once(this.fileStream, "error").then(([error]) => Promise.reject(error)),
    ]).then(() => callback(), callback);
  }

  _destroy(error, callback) {
    this.fileStream.destroy();
    callback(error);
  }

  #fail(error) {
    if (this.activeWriteFailure) this.activeWriteFailure(error);
    else this.destroy(error);
  }

  #write(stream, chunk, callback) {
    try {
      stream.write(chunk, callback);
    } catch (error) {
      callback(error);
    }
  }
}

function quoteWindowsCommandPart(part) {
  if (!part.length) return '""';
  if (!/[\s"]/u.test(part)) return part;
  return `"${part.replace(/"/gu, '\\"')}"`;
}

function spawnDescriptor(command, args) {
  if (process.platform !== "win32" || /\.(?:com|exe)$/iu.test(command)) return { args, command };
  return {
    args: ["/d", "/s", "/c", [command, ...args].map(quoteWindowsCommandPart).join(" ")],
    command: process.env.ComSpec ?? "cmd.exe",
  };
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function readableEnd(stream, formatter) {
  return new Promise((resolve) => {
    if (stream.readableEnded) {
      resolve();
      return;
    }
    stream.once("end", resolve);
    stream.once("error", (error) => {
      formatter.destroy(error);
      resolve();
    });
  });
}

function disposeChildTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return null;
  const failures = [];
  try {
    if (process.platform === "win32") {
      const taskkill = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        encoding: "utf8",
        timeout: DISPOSAL_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
      if (!taskkill.error && taskkill.status === 0) return null;
      failures.push(commandFailure("taskkill", taskkill));
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const systemTaskkill = spawnSync(`${systemRoot}\\System32\\taskkill.exe`, ["/pid", String(child.pid), "/t", "/f"], {
        encoding: "utf8",
        timeout: DISPOSAL_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
      if (!systemTaskkill.error && systemTaskkill.status === 0) return null;
      failures.push(commandFailure("systemTaskkill", systemTaskkill));
      const powershellPath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      const powershellScript = `$ErrorActionPreference="Stop"; $root=[int]${child.pid}; $processes=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); $targets=@($root); do { $next=@($processes | Where-Object { $targets -contains [int]$_.ParentProcessId -and $targets -notcontains [int]$_.ProcessId } | ForEach-Object { [int]$_.ProcessId }); $targets += $next } while ($next.Count -gt 0); [array]::Reverse($targets); foreach ($id in $targets) { try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { if (Get-Process -Id $id -ErrorAction SilentlyContinue) { throw } } }`;
      const powershell = spawnSync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", powershellScript], {
        encoding: "utf8",
        timeout: DISPOSAL_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });
      if (!powershell.error && powershell.status === 0) return null;
      failures.push(commandFailure("powershellTreeKill", powershell));
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
        return null;
      } catch (error) {
        if (error?.code === "ESRCH") return null;
        failures.push(`processGroupKill=${boundedError(error)}`);
      }
    }
    try {
      if (child.kill("SIGKILL")) failures.push("wrapperKill=sent");
      else failures.push("wrapperKill=notSent");
    } catch (error) {
      failures.push(`wrapperKill=${boundedError(error)}`);
    }
  } catch (error) {
    failures.push(`disposalException=${boundedError(error)}`);
  }
  return failures.join(" ").slice(0, 512) || "disposal could not be confirmed";
}

function boundedError(error) {
  return (error instanceof Error ? error.message : String(error)).replaceAll("\r", "\\r").replaceAll("\n", "\\n").slice(0, 160);
}

function commandFailure(name, result) {
  if (result.error) return `${name}Error=${boundedError(result.error)}`;
  if (result.signal) return `${name}Signal=${result.signal}`;
  const detail = typeof result.stderr === "string" && result.stderr.trim() ? ` stderr=${boundedError(result.stderr.trim())}` : "";
  return `${name}Status=${result.status ?? "unknown"}${detail}`;
}

async function openLogFile(logFilePath) {
  const handle = await open(logFilePath, "a+");
  try {
    const { size } = await handle.stat();
    if (size > 0) {
      const finalByte = Buffer.allocUnsafe(1);
      await handle.read(finalByte, 0, 1, size - 1);
      if (finalByte[0] !== 0x0a) await handle.write("\n");
    }
  } finally {
    await handle.close();
  }
  const stream = createWriteStream(logFilePath, { flags: "a" });
  await Promise.race([
    once(stream, "open"),
    once(stream, "error").then(([error]) => Promise.reject(error)),
  ]);
  return stream;
}

function waitForProcessAbsence(pid) {
  const deadline = Date.now() + DISPOSAL_EXIT_WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  do {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return null;
      if (error?.code === "EPERM") return "process probe returned EPERM; cleanup cannot be confirmed";
      return `processProbe=${boundedError(error)}`;
    }
    Atomics.wait(sleeper, 0, 0, 10);
  } while (Date.now() < deadline);
  return "process remained reachable through the bounded disposal wait";
}

export async function runOrchestratorCommand({ args, command, cwd, env, logFilePath, restartDelaySeconds, stdout = process.stdout }) {
  const fileStream = await openLogFile(logFilePath);
  const descriptor = spawnDescriptor(command, args);
  let child;
  try {
    child = spawn(descriptor.command, descriptor.args, {
      cwd,
      detached: process.platform !== "win32",
      env: { ...env, WORKBENCH_ORCHESTRATOR_LOOP: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    fileStream.destroy();
    throw error;
  }

  const exitPromise = childExit(child);
  await Promise.race([
    once(child, "spawn"),
    exitPromise.then((result) => result.code === null ? Promise.reject(new Error(`Orchestrator command exited during startup with signal ${result.signal}.`)) : undefined),
  ]);
  const formatter = new OrchestratorLogLineFormatter();
  const sink = new MirroredLogSink(fileStream, stdout);
  let loggingFailure = null;
  let resolveLoggingFailure;
  const loggingFailureSignal = new Promise((resolve) => { resolveLoggingFailure = resolve; });
  let loggingFailureHandling = false;
  const beginLoggingFailure = (error) => {
    if (loggingFailureHandling) return loggingFailureHandling;
    loggingFailureHandling = true;
    const disposalFailure = disposeChildTree(child);
    const absenceFailure = child.pid ? waitForProcessAbsence(child.pid) : "child pid was unavailable for disposal verification";
    child.stdout.destroy();
    child.stderr.destroy();
    if (absenceFailure) child.unref();
    loggingFailure = {
      disposalFailure: [disposalFailure, absenceFailure].filter(Boolean).join(" "),
      error,
    };
    resolveLoggingFailure(loggingFailure);
    return loggingFailureHandling;
  };
  sink.once("error", (error) => { void beginLoggingFailure(error); });
  const formatted = pipeline(formatter, sink).catch(beginLoggingFailure);
  const streamEnds = [readableEnd(child.stdout, formatter), readableEnd(child.stderr, formatter)];
  child.stdout.pipe(formatter, { end: false });
  child.stderr.pipe(formatter, { end: false });
  formatter.write("Starting orchestrator command\n");

  const outcome = await Promise.race([
    exitPromise.then((result) => ({ kind: "childExit", result })),
    loggingFailureSignal.then((failure) => ({ failure, kind: "loggingFailure" })),
  ]);
  if (outcome.kind === "loggingFailure") {
    const message = boundedError(outcome.failure.error);
    const disposal = outcome.failure.disposalFailure ? ` disposalFailure=${outcome.failure.disposalFailure}` : "";
    throw new LoggingSinkError(`${message}${disposal}`, child.pid ?? 0);
  }
  const result = outcome.result;
  await Promise.all(streamEnds);
  if (!loggingFailure) {
    const status = result.code ?? 1;
    formatter.write(`Orchestrator exited with code ${status}.\n`);
    formatter.end();
  }
  await formatted;
  if (loggingFailure) {
    const disposal = loggingFailure.disposalFailure ? ` disposalFailure=${loggingFailure.disposalFailure}` : "";
    throw new LoggingSinkError(`${boundedError(loggingFailure.error)}${disposal}`, child.pid ?? 0);
  }
  return result.code ?? 1;
}

function shortTimestamp(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function directDiagnostic(kind, childPid, error) {
  const message = (error instanceof Error ? error.message : String(error)).replaceAll("\r", "\\r").replaceAll("\n", "\\n").slice(0, 512);
  process.stderr.write(`[${shortTimestamp()}] kind=${kind} childPid=${childPid} message=${JSON.stringify(message)}\n`);
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const logFileIndex = argv.indexOf("--log-file");
  const delayIndex = argv.indexOf("--restart-delay-seconds");
  if (separator < 0 || logFileIndex < 0 || delayIndex < 0 || !argv[logFileIndex + 1] || !argv[delayIndex + 1] || !argv[separator + 1]) {
    throw new Error("Runner usage: --log-file <path> --restart-delay-seconds <seconds> -- <command> [args...]");
  }
  return {
    args: argv.slice(separator + 2),
    command: argv[separator + 1],
    logFilePath: argv[logFileIndex + 1],
    restartDelaySeconds: argv[delayIndex + 1],
  };
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    process.exitCode = await runOrchestratorCommand({ ...options, cwd: process.cwd(), env: process.env });
  } catch (error) {
    if (error instanceof LoggingSinkError) {
      directDiagnostic("loggingFailure", error.childPid, error);
      process.exitCode = LOGGING_FAILURE_EXIT_CODE;
    } else {
      directDiagnostic("runnerFailure", 0, error);
      process.exitCode = RUNNER_FAILURE_EXIT_CODE;
    }
  }
}
