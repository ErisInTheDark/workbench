/*
 * No production exports. Protect reported-endpoint health checks and owned-child recovery without timer races.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import WorkbenchDaemonHost from "./WorkbenchDaemonHost.ts";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, "pid", { value: 12345 });
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  Object.defineProperties(child, {
    exitCode: { get: () => exitCode },
    signalCode: { get: () => signalCode },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    exitCode = code;
    signalCode = signal;
  });
  return child;
}

function reportReady(child: ChildProcess) {
  child.emit("message", {
    type: "workbench-daemon-ready",
    endpoint: { version: 1, instanceId: "6e1a6f64-af71-4639-b997-65d8f314b352", pid: child.pid, origin: "http://127.0.0.1:32123" },
  });
}

class FakeClock {
  nowMs = 0;
  private nextId = 0;
  private readonly armedWaiters: Array<() => void> = [];
  private readonly callWaiters: Array<{ count: number; resolve: () => void }> = [];
  private sleepCalls = 0;
  private readonly sleepers = new Map<number, {
    dueAt: number;
    reject: (error: unknown) => void;
    resolve: () => void;
  }>();

  readonly now = () => this.nowMs;
  get nextDueAt() { return Math.min(...[...this.sleepers.values()].map(({ dueAt }) => dueAt)); }
  get pendingSleeps() { return this.sleepers.size; }

  readonly sleep = (delayMs: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const id = this.nextId++;
    const abort = () => {
      this.sleepers.delete(id);
      reject(signal?.reason);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    this.sleepers.set(id, {
      dueAt: this.nowMs + delayMs,
      reject,
      resolve: () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      },
    });
    this.sleepCalls += 1;
    this.armedWaiters.shift()?.();
    for (const waiter of this.callWaiters.splice(0)) {
      if (this.sleepCalls >= waiter.count) waiter.resolve();
      else this.callWaiters.push(waiter);
    }
  });

  async waitUntilArmed() {
    if (this.sleepers.size) return;
    await new Promise<void>((resolve) => this.armedWaiters.push(resolve));
  }

  async waitForSleepCall(count: number) {
    if (this.sleepCalls >= count) return;
    await new Promise<void>((resolve) => this.callWaiters.push({ count, resolve }));
  }

  advance(durationMs: number) {
    this.nowMs += durationMs;
    const ready = [...this.sleepers.entries()]
      .filter(([, sleeper]) => sleeper.dueAt <= this.nowMs)
      .sort((left, right) => left[1].dueAt - right[1].dueAt);
    for (const [id, sleeper] of ready) {
      this.sleepers.delete(id);
      sleeper.resolve();
    }
  }
}

function event() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fakeLog(lines: string[]) {
  return {
    close() {},
    createLineStream(_domain: "daemon", _error: boolean, onLine: () => void) {
      return {
        flush() {},
        write(chunk: string | Buffer) {
          if (chunk.toString().trim()) onLine();
        },
      };
    },
    error(_domain: "host", message: string) { lines.push(message); },
    line(_domain: "host", message: string) { lines.push(message); },
  };
}

test("probes the reported endpoint twice before retiring only its owned child", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-runner-"));
  context.after(async () => await rm(root, { force: true, recursive: true }));
  const clock = new FakeClock();
  const child = fakeChild();
  const lines: string[] = [];
  const probes: number[] = [];
  const deadlineCleanup = event();
  const firstProbe = event();
  const secondProbe = event();
  const spawned = event();
  let kills = 0;
  let spawns = 0;
  const runner = new WorkbenchDaemonHost({
    environment: {
      LOG_IDLE_TIMEOUT_SECONDS: "3",
      MAX_LOG_FILES: "5",
      MAX_LOG_LINES: "1000",
      RESTART_DELAY_SECONDS: "3",
    },
    healthClient: {
      probe: async (url, timeoutMs) => {
        assert.equal(url, "ws://127.0.0.1:32123");
        probes.push(timeoutMs);
        (probes.length === 1 ? firstProbe : secondProbe).resolve();
        throw new Error("fixture unavailable");
      },
    },
    loggerFactory: () => fakeLog(lines),
    now: clock.now,
    projectRootPath: root,
    terminateChild: async owned => {
      assert.equal(owned, child);
      kills += 1;
      deadlineCleanup.resolve();
      queueMicrotask(() => child.emit("exit", 7, null));
    },
    sleep: clock.sleep,
    spawnDaemon: () => {
      spawns += 1;
      spawned.resolve();
      queueMicrotask(() => reportReady(child));
      return child;
    },
  });

  let runError: unknown = null;
  const running = runner.run().catch((error: unknown) => { runError = error; });
  await Promise.race([
    spawned.promise,
    running.then(() => { throw runError ?? new Error("Runner stopped before spawning."); }),
  ]);
  assert.equal(runError, null);
  await clock.waitUntilArmed();
  assert.equal(kills, 0);

  clock.advance(1_500);
  await firstProbe.promise;
  await clock.waitUntilArmed();
  assert.deepEqual(probes, [500]);

  clock.advance(750);
  await secondProbe.promise;
  await clock.waitUntilArmed();
  assert.deepEqual(probes, [500, 500]);

  clock.advance(750);
  await deadlineCleanup.promise;
  assert.equal(kills, 1);

  await runner.stop();
  await running;
  assert.equal(spawns, 1);
});

test("stop exits a paused runner without spawning or deleting the sentinel", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-runner-paused-"));
  context.after(async () => await rm(root, { force: true, recursive: true }));
  const sentinel = path.join(root, ".workbench", "daemon-loop.pause");
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "", "utf8");
  const clock = new FakeClock();
  let spawns = 0;
  const runner = new WorkbenchDaemonHost({
    environment: {},
    loggerFactory: () => fakeLog([]),
    now: clock.now,
    projectRootPath: root,
    terminateChild: async () => assert.fail("A paused runner owns no child."),
    sleep: clock.sleep,
    spawnDaemon: () => {
      spawns += 1;
      return new EventEmitter() as ChildProcess;
    },
  });

  const running = runner.run();
  await clock.waitUntilArmed();
  await runner.stop();
  await running;

  assert.equal(spawns, 0);
  await access(sentinel);
});

test("child output cancels the stale wait before arming a fresh silence window", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workbench-runner-output-"));
  context.after(async () => await rm(root, { force: true, recursive: true }));
  const clock = new FakeClock();
  const child = fakeChild();
  let kills = 0;
  const spawned = event();
  const runner = new WorkbenchDaemonHost({
    environment: {},
    healthClient: { probe: async () => assert.fail("Output should reschedule before the probe.") },
    loggerFactory: () => fakeLog([]),
    now: clock.now,
    projectRootPath: root,
    terminateChild: async owned => {
      assert.equal(owned, child);
      kills += 1;
      queueMicrotask(() => child.emit("exit", 0, null));
    },
    sleep: clock.sleep,
    spawnDaemon: () => {
      spawned.resolve();
      return child;
    },
  });

  const running = runner.run();
  await spawned.promise;
  await clock.waitForSleepCall(1);
  clock.advance(30_000);
  child.stdout!.emit("data", Buffer.from("still active\n"));
  await clock.waitForSleepCall(2);

  assert.equal(clock.pendingSleeps, 1);
  assert.equal(clock.nextDueAt, 90_000);

  await runner.stop();
  await running;
  assert.equal(kills, 1);
});
