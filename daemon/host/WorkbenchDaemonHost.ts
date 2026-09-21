/*
 * Exports:
 * - WorkbenchDaemonHostOptions: owned child, supervision and observation boundaries.
 * - default WorkbenchDaemonHost: own daemon child startup, endpoint readiness, logs, health recovery, restart and shutdown.
 * Local mechanics:
 * - RunnerLog writes one plain formatted stream to terminal and the active file.
 * - WakeSignal wakes a pending watchdog wait when child output changes lifecycle truth.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

import WorkbenchProcessLogger from "../../shared/process/WorkbenchProcessLogger.ts";
import { WorkbenchDaemonReadySchema, type WorkbenchDaemonEndpoint } from "../../shared/http/workbench-daemon-endpoint.ts";
// The heavy daemon remains CommonJS; resolve its existing process owner at that boundary.
const { killProcessTreeAsync } = createRequire(import.meta.url)("../server/process-helpers.ts") as typeof import("../server/process-helpers.ts");

import DaemonHealthWatchdog from "./DaemonHealthWatchdog.ts";
import WorkbenchDaemonHealthClient from "./WorkbenchDaemonHealthClient.ts";
import { DaemonSleepMessageSchema, type DaemonHostMessage } from "../../shared/http/workbench-daemon-lifecycle.ts";

type RunnerChildResult = {
  error?: Error;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
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

export interface WorkbenchDaemonHostOptions {
  hasDemand?(): boolean;
  onSleep?(): Promise<void>;
  environment?: NodeJS.ProcessEnv;
  healthClient?: Pick<WorkbenchDaemonHealthClient, "probe">;
  loggerFactory?: (logFilePath: string) => RunnerLog;
  writeLog?: (value: string, error: boolean) => void;
  now?: () => number;
  projectRootPath: string;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  spawnDaemon?: (daemonDirectoryPath: string, environment: NodeJS.ProcessEnv) => ChildProcess;
  terminateChild?: (child: ChildProcess) => Promise<void>;
  onFailure?: (error: Error, beforeReady: boolean) => Promise<void> | void;
  requestRestart?: (fatal?: boolean) => void;
  lifetime?: AbortSignal;
}

type DaemonLifecycle =
  | { state: "sleeping" | "stopped" }
  | { state: "starting"; ready: { promise: Promise<WorkbenchDaemonEndpoint>; resolve(endpoint: WorkbenchDaemonEndpoint): void; reject(error: Error): void } }
  | { state: "ready"; endpoint: WorkbenchDaemonEndpoint }
  | { state: "failed"; error: Error };

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

  constructor(logFilePath: string, writeLog?: (value: string, error: boolean) => void) {
    this.descriptor = openSync(logFilePath, "a");
    const write = (error: boolean, value: string) => {
      if (this.closed) throw new Error("Daemon host log is closed.");
      if (writeLog) writeLog(value, error);
      else (error ? process.stderr : process.stdout).write(value);
      writeSync(this.descriptor, value);
    };
    this.logger = new WorkbenchProcessLogger({
      writeError: (value) => write(true, value),
      writeOutput: (value) => write(false, value),
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

function defaultSpawnDaemon(daemonDirectoryPath: string, environment: NodeJS.ProcessEnv) {
  return spawn(process.execPath, ["--env-file-if-exists=.env.local", "--import", "tsx", "server/index.ts"], {
    cwd: daemonDirectoryPath,
    env: { ...environment, WORKBENCH_DAEMON_LOOP: "1", FORCE_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    detached: process.platform !== "win32",
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
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly spawnDaemon: (daemonDirectoryPath: string, environment: NodeJS.ProcessEnv) => ChildProcess;
  private readonly terminateChild: (child: ChildProcess) => Promise<void>;
  private stopAbort = new AbortController();
  private activeAbort: AbortController | null = null;
  private activeChild: ChildProcess | null = null;
  private retirement: Promise<void> | null = null;
  private activeLog: RunnerLog | null = null;
  private stopping = false;
  private lifecycle: DaemonLifecycle = { state: "sleeping" };
  private runTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private sleepTransition: { id: string; accepted: boolean; done: Promise<void>; resolve(): void } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: WorkbenchDaemonHostOptions) {
    this.projectRootPath = options.projectRootPath;
    this.daemonDirectoryPath = path.join(this.projectRootPath, "daemon");
    this.logDirectoryPath = path.join(this.projectRootPath, ".workbench", "logs");
    this.pauseSentinelPath = path.join(this.projectRootPath, ".workbench", "daemon-loop.pause");
    this.environment = options.environment ?? process.env;
    this.healthClient = options.healthClient ?? new WorkbenchDaemonHealthClient();
    this.loggerFactory = options.loggerFactory ?? ((logFilePath) => new RunnerLogFile(logFilePath, options.writeLog));
    this.now = options.now ?? (() => performance.now());
    this.terminateChild = options.terminateChild ?? (child => killProcessTreeAsync(child.pid));
    this.sleep = options.sleep ?? abortableSleep;
    this.spawnDaemon = options.spawnDaemon ?? defaultSpawnDaemon;
    this.maxLogLines = positiveInteger(this.environment, "MAX_LOG_LINES", 1_000);
    this.maxLogFiles = positiveInteger(this.environment, "MAX_LOG_FILES", 5);
    this.logIdleTimeoutSeconds = positiveInteger(this.environment, "LOG_IDLE_TIMEOUT_SECONDS", 120);
    this.idleTimeoutMs = this.logIdleTimeoutSeconds * 1_000;
    this.probeTimeoutMs = Math.max(1, Math.floor(this.idleTimeoutMs / 6));
    this.restartDelayMs = positiveInteger(this.environment, "RESTART_DELAY_SECONDS", 3) * 1_000;
  }

  snapshot() {
    return {
      state: this.sleepTransition && this.lifecycle.state === "ready" ? "sleeping" as const : this.lifecycle.state,
      endpoint: !this.sleepTransition && this.lifecycle.state === "ready" ? this.lifecycle.endpoint : null,
      failure: this.lifecycle.state === "failed" ? this.lifecycle.error.message.slice(0, 512) : null,
    };
  }

  get isSupervising() { return this.runTask !== null; }
  async waitForSleep() { await this.sleepTransition?.done; }

  demandChanged() {
    if (!this.options.hasDemand || !this.activeChild?.connected) return;
    void this.sendHost({ type: "workbench-daemon-demand", required: this.options.hasDemand() })
      .catch(error => this.directLogger.error("host", `Demand publication failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`));
  }

  private sendHost(message: DaemonHostMessage) {
    return new Promise<void>((resolve, reject) => {
      if (!this.activeChild?.connected) { reject(new Error("Daemon IPC is unavailable.")); return; }
      this.activeChild.send(message, error => error ? reject(error) : resolve());
    });
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  wake(): Promise<WorkbenchDaemonEndpoint> {
    if (this.options.lifetime?.aborted) return Promise.reject(this.options.lifetime.reason);
    if (this.stopTask) return this.stopTask.then(() => this.wake());
    if (this.sleepTransition) return this.sleepTransition.done.then(() => this.wake());
    if (this.lifecycle.state === "ready") return Promise.resolve(this.lifecycle.endpoint);
    if (this.lifecycle.state === "starting") return this.lifecycle.ready.promise;
    if (this.lifecycle.state === "stopped") {
      this.stopping = false;
      this.stopAbort = new AbortController();
      this.lifecycle = { state: "sleeping" };
    }
    if (this.lifecycle.state === "failed") return Promise.reject(this.lifecycle.error);
    let resolve!: (endpoint: WorkbenchDaemonEndpoint) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<WorkbenchDaemonEndpoint>((accept, fail) => { resolve = accept; reject = fail; });
    const ready = { promise, resolve, reject };
    this.lifecycle = { state: "starting", ready };
    this.publish();
    void this.run().catch(error => {
      // run records and publishes lifecycle failure; this boundary owns diagnostics
      // for callers that already received readiness before supervision failed.
      this.directLogger.error("host", `supervision failed: ${error instanceof Error ? error.message.slice(0, 512) : "unknown failure"}`);
    });
    return ready.promise;
  }

  run({ dryRun = false }: { dryRun?: boolean } = {}) {
    if (dryRun) {
      this.directLogger.line("host", "dry run: Workbench would start an owned daemon on a random loopback port.");
      return Promise.resolve();
    }
    if (!this.runTask) this.runTask = this.supervise().catch(async error => {
      if (!this.stopping && this.lifecycle.state !== "failed") {
        await this.fail(error instanceof Error ? error : new Error(String(error)), this.lifecycle.state !== "ready");
      }
      throw error;
    }).finally(() => {
      this.runTask = null;
      const sleeping = this.sleepTransition;
      this.sleepTransition = null;
      sleeping?.resolve();
    });
    return this.runTask;
  }

  private async supervise() {
    await mkdir(this.logDirectoryPath, { recursive: true });
    await this.pruneLogFiles();
    const logFilePath = await this.selectLogFile(0);
    const log = this.loggerFactory(logFilePath);
    this.activeLog = log;
    try {
      await this.waitWhilePaused(log);
      if (this.stopping) return;
      this.logConfiguration(log);
      log.line("host", `logging complete daemon output to: ${logFilePath}`);
      const result = await this.runChild(log);
      if (this.stopping) return;
      if (this.sleepTransition?.accepted && result.exitCode === 0 && !result.error) {
        await this.options.onSleep?.();
        this.lifecycle = { state: "sleeping" };
        log.line("host", "daemon is idle and sleeping; wake service remains available.");
        this.publish();
        return;
      }
      const beforeReady = this.lifecycle.state !== "ready";
      const error = result.error ?? new Error(
        `Daemon exited ${beforeReady ? "before readiness" : "after readiness"} with ${result.exitCode ?? result.signal ?? "unknown status"}.`,
      );
      await this.fail(error, beforeReady);
      this.options.requestRestart?.();
      if (!this.options.requestRestart) throw error;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (!this.stopping && this.lifecycle.state !== "failed") await this.fail(normalized, this.lifecycle.state !== "ready");
      throw error;
    } finally {
      if (this.activeLog === log) this.activeLog = null;
      log.close();
    }
  }

  stop(reason = "Daemon host stopped."): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (this.stopping) return this.lifecycle.state === "failed"
      ? Promise.reject(this.lifecycle.error) : Promise.resolve();
    this.stopping = true;
    if (this.lifecycle.state === "starting") this.lifecycle.ready.reject(new Error(reason));
    this.lifecycle = { state: "stopped" };
    this.publish();
    this.stopAbort.abort(new Error(reason));
    this.activeAbort?.abort(new Error(reason));
    const task = (async () => {
      await this.retireChild();
      if (this.runTask) await this.runTask;
    })().catch(error => {
      this.lifecycle = { state: "failed", error: error instanceof Error ? error : new Error(String(error)) };
      this.publish();
      throw error;
    }).finally(() => { if (this.stopTask === task) this.stopTask = null; });
    this.stopTask = task;
    return task;
  }

  private async runChild(log: RunnerLog) {
    const abort = new AbortController();
    this.activeAbort = abort;
    const child = this.spawnDaemon(this.daemonDirectoryPath, this.environment);
    this.activeChild = child;
    const exited = childResult(child);
    const watchdog = new DaemonHealthWatchdog(this.idleTimeoutMs, this.now());
    const wake = new WakeSignal();
    const readiness: { endpoint: WorkbenchDaemonEndpoint | null; failure: Error | null } = {
      endpoint: null, failure: null,
    };
    const acceptReady = (message: object) => {
      const sleep = DaemonSleepMessageSchema.safeParse(message);
      if (sleep.success) {
        if (sleep.data.type === "workbench-daemon-sleep-request") {
          const allowed = this.lifecycle.state === "ready" && !this.stopping && !this.sleepTransition
            && !(this.options.hasDemand?.() ?? true);
          if (allowed) {
            let resolve!: () => void;
            const done = new Promise<void>(settle => { resolve = settle; });
            this.sleepTransition = { id: sleep.data.id, accepted: false, done, resolve };
            this.publish();
          }
          void this.sendHost({ type: "workbench-daemon-sleep-commit", id: sleep.data.id, allowed })
            .catch(error => { readiness.failure = error instanceof Error ? error : new Error(String(error)); wake.wake(); });
        } else if (this.sleepTransition?.id === sleep.data.id) {
          if (sleep.data.accepted) this.sleepTransition.accepted = true;
          else {
            const transition = this.sleepTransition;
            this.sleepTransition = null;
            transition.resolve();
            this.publish();
          }
        }
        wake.wake();
        return;
      }
      const parsed = WorkbenchDaemonReadySchema.safeParse(message);
      if (!parsed.success || parsed.data.endpoint.pid !== child.pid) {
        readiness.failure = new Error("Daemon sent an invalid process-bound readiness message.");
      } else if (readiness.endpoint && (
        readiness.endpoint.instanceId !== parsed.data.endpoint.instanceId || readiness.endpoint.origin !== parsed.data.endpoint.origin
      )) {
        readiness.failure = new Error("Daemon changed its published process endpoint unexpectedly.");
      } else {
        readiness.endpoint = parsed.data.endpoint;
        if (!this.stopping) {
          if (this.lifecycle.state === "starting") this.lifecycle.ready.resolve(parsed.data.endpoint);
          this.lifecycle = { state: "ready", endpoint: parsed.data.endpoint };
          this.demandChanged();
          this.publish();
        }
      }
      wake.wake();
    };
    child.on("message", acceptReady);
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
        if (this.sleepTransition?.accepted) return await exited;
        if (readiness.failure) {
          await this.retireChild();
          await exited;
          return { error: readiness.failure, exitCode: null, signal: null };
        }
        const action = watchdog.nextAction(this.now());
        if (action.kind === "restart") {
          log.error("host", `no daemon output or successful WebSocket health response was received for ${this.logIdleTimeoutSeconds} seconds; retiring the owned child for restart.`);
          await this.retireChild();
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
        const endpointProbe = readiness.endpoint
          ? this.healthClient.probe(readiness.endpoint.origin.replace("http:", "ws:"), this.probeTimeoutMs, probeAbort.signal)
          : Promise.reject(new Error("Daemon has not published a ready endpoint."));
        const probe = endpointProbe
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
      child.off("message", acceptReady);
      await this.retireChild();
      stdout.flush();
      stderr.flush();
      if (this.activeChild === child) this.activeChild = null;
      if (this.activeAbort === abort) this.activeAbort = null;
    }
  }

  private logConfiguration(log: RunnerLog) {
    log.line("host", "starting an owned Workbench daemon.");
    log.line("host", "command: node --import tsx server/index.ts");
    log.line("host", `working directory: ${this.daemonDirectoryPath}`);
    log.line("host", "listener: OS-assigned loopback port, reported by the owned child.");
    log.line("host", `log directory: ${this.logDirectoryPath}`);
    log.line("host", `log rotation: more than ${this.maxLogLines} lines`);
    log.line("host", `log retention: ${this.maxLogFiles} files`);
    log.line("host", "recovery: replace the managed host crash unit before restarting descendants.");
    log.line("host", `inactivity recovery: WebSocket probes at ${this.logIdleTimeoutSeconds / 2} and ${this.logIdleTimeoutSeconds * 3 / 4} seconds; restart after ${this.logIdleTimeoutSeconds} seconds`);
    log.line("host", `pause sentinel: ${this.pauseSentinelPath}`);
    log.line("host", "press Ctrl+C to stop.");
  }

  private retireChild(): Promise<void> {
    if (this.retirement) return this.retirement;
    const child = this.activeChild;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const retirement = this.terminateChild(child).finally(() => {
      if (this.retirement === retirement) this.retirement = null;
    });
    this.retirement = retirement;
    return retirement;
  }

  private async fail(error: Error, beforeReady: boolean) {
    if (this.lifecycle.state === "starting") this.lifecycle.ready.reject(error);
    this.lifecycle = { state: "failed", error };
    this.publish();
    try { await this.options.onFailure?.(error, beforeReady); }
    catch (failure) {
      this.options.requestRestart?.(true);
      throw failure;
    }
  }

  private publish() { for (const listener of this.listeners) listener(); }

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
