/*
 * Exports:
 * - default WorkbenchDaemonHost: own daemon child startup, logs, pause, health recovery, port cleanup, restart, and shutdown.
 * Local mechanics:
 * - RunnerLog writes one plain formatted stream to terminal and the active file.
 * - WakeSignal wakes a pending watchdog wait when child output changes lifecycle truth.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import WorkbenchProcessLogger from "../../shared/process/WorkbenchProcessLogger.ts";
import {
  deriveWorkbenchRuntimeTopology,
  type WorkbenchRuntimeTopology,
} from "../../shared/workbench/runtime-topology.ts";

import DaemonHealthWatchdog from "./DaemonHealthWatchdog.ts";
import WorkbenchDaemonHealthClient from "./WorkbenchDaemonHealthClient.ts";

type RunnerChildResult = {
  error?: Error;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type RunnerCommandResult = {
  error?: Error;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

interface RunnerLog {
  close(): void;
  createLineStream(domain: "daemon", error: boolean, onLine: () => void): {
    flush(): void;
    write(chunk: string | Buffer): void;
  };
  error(domain: "host", message: string): void;
  line(domain: "host", message: string): void;
}

interface WorkbenchDaemonHostOptions {
  environment?: NodeJS.ProcessEnv;
  healthClient?: Pick<WorkbenchDaemonHealthClient, "probe">;
  loggerFactory?: (logFilePath: string) => RunnerLog;
  now?: () => number;
  projectRootPath: string;
  runCommand?: (command: string, args: readonly string[]) => Promise<RunnerCommandResult>;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  spawnDaemon?: (daemonDirectoryPath: string, environment: NodeJS.ProcessEnv) => ChildProcess;
  topology?: WorkbenchRuntimeTopology;
}

class WakeSignal {
  private current = this.create();

  wait() {
    return this.current.promise;
  }

  wake() {
    this.current.resolve();
    this.current = this.create();
  }

  private create() {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => { resolve = settle; });
    return { promise, resolve };
  }
}

class RunnerLogFile implements RunnerLog {
  private closed = false;
  private readonly descriptor: number;
  private readonly logger: WorkbenchProcessLogger;

  constructor(logFilePath: string) {
    this.descriptor = openSync(logFilePath, "a");
    const write = (stream: NodeJS.WriteStream, value: string) => {
      if (this.closed) throw new Error("Daemon host log is closed.");
      stream.write(value);
      writeSync(this.descriptor, value);
    };
    this.logger = new WorkbenchProcessLogger({
      writeError: (value) => write(process.stderr, value),
      writeOutput: (value) => write(process.stdout, value),
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.descriptor);
  }

  createLineStream(domain: "daemon", error: boolean, onLine: () => void) {
    return this.logger.createLineStream(domain, error, onLine);
  }

  error(domain: "host", message: string) {
    this.logger.error(domain, message);
  }

  line(domain: "host", message: string) {
    this.logger.line(domain, message);
  }
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = environment[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function executable(name: string) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function abortableSleep(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function defaultRunCommand(command: string, args: readonly string[]) {
  return new Promise<RunnerCommandResult>((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => resolve({ error, exitCode: null, signal: null, stderr, stdout }));
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal, stderr, stdout }));
  });
}

function defaultSpawnDaemon(daemonDirectoryPath: string, environment: NodeJS.ProcessEnv) {
  return spawn(executable("pnpm"), ["dev:daemon"], {
    cwd: daemonDirectoryPath,
    env: { ...environment, WORKBENCH_DAEMON_LOOP: "1", FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32",
  });
}

function childResult(child: ChildProcess) {
  return new Promise<RunnerChildResult>((resolve) => {
    let settled = false;
    const finish = (result: RunnerChildResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => finish({ error, exitCode: null, signal: null }));
    child.once("exit", (exitCode, signal) => finish({ exitCode, signal }));
  });
}

function outputLines(value: string) {
  return value.split(/\r\n|\n|\r/gu).map((line) => line.trimEnd()).filter(Boolean);
}

export default class WorkbenchDaemonHost {
  private readonly daemonDirectoryPath: string;
  private readonly directLogger = new WorkbenchProcessLogger();
  private readonly environment: NodeJS.ProcessEnv;
  private readonly healthClient: Pick<WorkbenchDaemonHealthClient, "probe">;
  private readonly idleTimeoutMs: number;
  private readonly loggerFactory: (logFilePath: string) => RunnerLog;
  private readonly logDirectoryPath: string;
  private readonly logIdleTimeoutSeconds: number;
  private readonly maxLogFiles: number;
  private readonly maxLogLines: number;
  private readonly now: () => number;
  private readonly pauseSentinelPath: string;
  private readonly probeTimeoutMs: number;
  private readonly projectRootPath: string;
  private readonly restartDelayMs: number;
  private readonly runCommand: (command: string, args: readonly string[]) => Promise<RunnerCommandResult>;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly spawnDaemon: (daemonDirectoryPath: string, environment: NodeJS.ProcessEnv) => ChildProcess;
  private readonly topology: WorkbenchRuntimeTopology;
  private readonly stopAbort = new AbortController();
  private activeAbort: AbortController | null = null;
  private activeChild: ChildProcess | null = null;
  private activeLog: RunnerLog | null = null;
  private stopping = false;

  constructor(options: WorkbenchDaemonHostOptions) {
    this.projectRootPath = options.projectRootPath;
    this.daemonDirectoryPath = path.join(this.projectRootPath, "daemon");
    this.logDirectoryPath = path.join(this.projectRootPath, ".workbench", "logs");
    this.pauseSentinelPath = path.join(this.projectRootPath, ".workbench", "daemon-loop.pause");
    this.environment = options.environment ?? process.env;
    this.topology = options.topology ?? deriveWorkbenchRuntimeTopology(this.environment);
    this.healthClient = options.healthClient ?? new WorkbenchDaemonHealthClient();
    this.loggerFactory = options.loggerFactory ?? ((logFilePath) => new RunnerLogFile(logFilePath));
    this.now = options.now ?? (() => performance.now());
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.sleep = options.sleep ?? abortableSleep;
    this.spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon;
    this.maxLogLines = positiveInteger(this.environment, "MAX_LOG_LINES", 1_000);
    this.maxLogFiles = positiveInteger(this.environment, "MAX_LOG_FILES", 5);
    this.logIdleTimeoutSeconds = positiveInteger(this.environment, "LOG_IDLE_TIMEOUT_SECONDS", 120);
    this.idleTimeoutMs = this.logIdleTimeoutSeconds * 1_000;
    this.probeTimeoutMs = Math.max(1, Math.floor(this.idleTimeoutMs / 6));
    this.restartDelayMs = positiveInteger(this.environment, "RESTART_DELAY_SECONDS", 3) * 1_000;
  }

  async run({ dryRun = false }: { dryRun?: boolean } = {}) {
    if (dryRun) {
      this.directLogger.line("host", `dry run: Workbench would kill listeners on configured ports: ${this.topology.listeners.map(({ port }) => port).join(" ")}`);
      return;
    }
    await mkdir(this.logDirectoryPath, { recursive: true });
    await this.pruneLogFiles();
    let restartNumber = 0;
    while (!this.stopping) {
      const logFilePath = await this.selectLogFile(restartNumber);
      const log = this.loggerFactory(logFilePath);
      this.activeLog = log;
      try {
        await this.pruneLogFiles();
        await this.waitWhilePaused(log);
        if (this.stopping) break;
        if (restartNumber === 0) this.logConfiguration(log);
        log.line("host", `logging complete daemon output to: ${logFilePath}`);
        await this.killOwnedPorts(log);
        if (this.stopping) break;
        const result = await this.runChild(log);
        if (this.stopping) break;
        if (result.error) throw result.error;
        restartNumber += 1;
        log.line("host", `restarting Workbench daemon in ${this.restartDelayMs / 1_000} seconds after child status ${result.exitCode ?? result.signal ?? "unknown"}.`);
        try {
          await this.sleep(this.restartDelayMs, this.stopAbort.signal);
        } catch (error) {
          if (!this.stopping) throw error;
        }
      } finally {
        if (this.activeLog === log) this.activeLog = null;
        log.close();
      }
    }
  }

  async stop(reason = "Daemon host stopped.") {
    if (this.stopping) return;
    this.stopping = true;
    this.stopAbort.abort(new Error(reason));
    this.activeAbort?.abort(new Error(reason));
    if (this.activeChild) await this.killOwnedPorts(this.activeLog);
  }

  private async runChild(log: RunnerLog) {
    const abort = new AbortController();
    this.activeAbort = abort;
    const child = this.spawnDaemon(this.daemonDirectoryPath, this.environment);
    this.activeChild = child;
    const exited = childResult(child);
    const watchdog = new DaemonHealthWatchdog(this.idleTimeoutMs, this.now());
    const wake = new WakeSignal();
    const observeOutput = () => {
      watchdog.observeOutput(this.now());
      wake.wake();
    };
    const stdout = log.createLineStream("daemon", false, observeOutput);
    const stderr = log.createLineStream("daemon", true, observeOutput);
    child.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));

    try {
      while (!this.stopping) {
        const action = watchdog.nextAction(this.now());
        if (action.kind === "restart") {
          log.error("host", `no daemon output or successful WebSocket health response was received for ${this.logIdleTimeoutSeconds} seconds; killing owned ports for restart.`);
          await this.killOwnedPorts(log);
          return await exited;
        }
        if (action.kind === "wait") {
          const waitAbort = new AbortController();
          const stopWait = () => waitAbort.abort(abort.signal.reason);
          abort.signal.addEventListener("abort", stopWait, { once: true });
          const sleeping = this.sleep(action.delayMs, waitAbort.signal).then(
            () => ({ kind: "timer" as const }),
            (error: unknown) => ({ error, kind: "abort" as const }),
          );
          const winner = await Promise.race([
            exited.then((result) => ({ kind: "exit" as const, result })),
            wake.wait().then(() => ({ kind: "wake" as const })),
            sleeping,
          ]);
          abort.signal.removeEventListener("abort", stopWait);
          if (winner.kind !== "timer" && !waitAbort.signal.aborted) {
            waitAbort.abort(new Error("Daemon watchdog wait became stale."));
            await sleeping;
          }
          if (winner.kind === "exit") return winner.result;
          if (winner.kind === "abort") {
            if (this.stopping) return await exited;
            throw winner.error;
          }
          continue;
        }
        const probeAbort = new AbortController();
        const stopProbe = () => probeAbort.abort(abort.signal.reason);
        abort.signal.addEventListener("abort", stopProbe, { once: true });
        const probeAfterSeconds = this.logIdleTimeoutSeconds * (action.token.attempt === 1 ? 0.5 : 0.75);
        log.line("host", `probing daemon WebSocket health after ${probeAfterSeconds} seconds without output (attempt ${action.token.attempt}/2).`);
        const probe = this.healthClient.probe(this.topology.endpoints.bridge, this.probeTimeoutMs, probeAbort.signal)
          .then(() => ({ kind: "probe" as const, succeeded: true, message: "" }))
          .catch((error: unknown) => ({
            kind: "probe" as const,
            succeeded: false,
            message: error instanceof Error ? error.message : String(error),
          }));
        const winner = await Promise.race([
          probe,
          exited.then((result) => ({ kind: "exit" as const, result })),
          wake.wait().then(() => ({ kind: "wake" as const })),
        ]);
        abort.signal.removeEventListener("abort", stopProbe);
        if (winner.kind !== "probe") {
          probeAbort.abort(new Error("Daemon health probe became stale."));
          await probe;
          if (winner.kind === "exit") return winner.result;
          continue;
        }
        if (!watchdog.completeProbe(action.token, winner.succeeded, this.now())) continue;
        if (winner.succeeded) log.line("host", "daemon WebSocket health probe succeeded.");
        else log.error("host", `daemon WebSocket health probe failed (${action.token.attempt}/2): ${winner.message.slice(0, 500)}`);
      }
      return await exited;
    } finally {
      abort.abort(new Error("Daemon child supervision ended."));
      stdout.flush();
      stderr.flush();
      if (this.activeChild === child) this.activeChild = null;
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  private logConfiguration(log: RunnerLog) {
    log.line("host", "starting Workbench daemon restart loop.");
    log.line("host", "command: pnpm dev:daemon");
    log.line("host", `working directory: ${this.daemonDirectoryPath}`);
    log.line("host", `owned ports: ${this.topology.listeners.map(({ port }) => port).join(" ")}`);
    log.line("host", `log directory: ${this.logDirectoryPath}`);
    log.line("host", `log rotation: more than ${this.maxLogLines} lines`);
    log.line("host", `log retention: ${this.maxLogFiles} files`);
    log.line("host", `restart delay: ${this.restartDelayMs / 1_000} seconds`);
    log.line("host", `inactivity recovery: WebSocket probes at ${this.logIdleTimeoutSeconds / 2} and ${this.logIdleTimeoutSeconds * 3 / 4} seconds; restart after ${this.logIdleTimeoutSeconds} seconds`);
    log.line("host", `pause sentinel: ${this.pauseSentinelPath}`);
    log.line("host", "press Ctrl+C to stop.");
  }

  private async killOwnedPorts(log: RunnerLog | null) {
    for (const { port } of this.topology.listeners) {
      const result = await this.runCommand(
        "bash",
        ["-lc", 'kill-by-port "$1"', "--", String(port)],
      );
      for (const line of outputLines(result.stdout)) (log ?? this.directLogger).line("host", line);
      for (const line of outputLines(result.stderr)) (log ?? this.directLogger).error("host", line);
      if (result.error) throw result.error;
      if (result.exitCode !== 0) {
        throw new Error(`kill-by-port failed for port ${port} with status ${result.exitCode ?? result.signal ?? "unknown"}.`);
      }
    }
  }

  private async waitWhilePaused(log: RunnerLog) {
    let announced = false;
    while (!this.stopping && await this.exists(this.pauseSentinelPath)) {
      if (!announced) {
        log.line("host", `daemon restart loop paused by sentinel: ${this.pauseSentinelPath}`);
        announced = true;
      }
      try {
        await this.sleep(this.restartDelayMs, this.stopAbort.signal);
      } catch (error) {
        if (!this.stopping) throw error;
      }
    }
    if (announced && !this.stopping) log.line("host", "daemon restart loop pause released.");
  }

  private async selectLogFile(restartNumber: number) {
    const files = await this.logFiles();
    if (!files.length) return await this.createLogFile(restartNumber);
    const latest = files.at(-1)!;
    const lineCount = (await readFile(latest, "utf8")).split("\n").length - 1;
    return lineCount > this.maxLogLines ? await this.createLogFile(restartNumber) : latest;
  }

  private async createLogFile(restartNumber: number) {
    const timestamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
    const filePath = path.join(
      this.logDirectoryPath,
      `workbench-daemon-${timestamp}-${process.pid}-${String(restartNumber).padStart(4, "0")}.log`,
    );
    await writeFile(filePath, "", "utf8");
    return filePath;
  }

  private async pruneLogFiles() {
    const files = await this.logFiles();
    for (const filePath of files.slice(0, Math.max(0, files.length - this.maxLogFiles))) {
      await unlink(filePath);
    }
  }

  private async logFiles() {
    const names = await readdir(this.logDirectoryPath);
    return names
      .filter((name) => /^workbench-daemon-.*\.log$/u.test(name))
      .sort()
      .map((name) => path.join(this.logDirectoryPath, name));
  }

  private async exists(filePath: string) {
    try {
      await access(filePath);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }
}
