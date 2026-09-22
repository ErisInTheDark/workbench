/* No exports. Tests protect scenario retirement, single cleanup ownership and bounded failure evidence. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import IsolatedWorkbenchProcess from "./IsolatedWorkbenchProcess";
import { createSpawnOptions } from "../../daemon/server/process-helpers";

function child() {
  const process = new EventEmitter() as ChildProcess;
  Object.defineProperties(process, {
    connected: { value: true, writable: true },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
    pid: { value: 12345 },
    stderr: { value: new EventEmitter() },
  });
  process.stderr!.destroy = () => process.stderr!;
  process.send = ((_message: object, callback?: (error: Error | null) => void) => {
    callback?.(null);
    return true;
  }) as ChildProcess["send"];
  const exit = (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
    Object.defineProperty(process, "exitCode", { value: code });
    Object.defineProperty(process, "signalCode", { value: signal });
    process.emit("exit", code, signal);
  };
  return { process, exit };
}

test("expired graceful shutdown retires the exact child but remains a test failure", async () => {
  const owned = child();
  const retired: number[] = [];
  const deadline = new Error("graceful shutdown expired");
  const process = new IsolatedWorkbenchProcess("host", owned.process, {
    gracefulSignal: () => AbortSignal.abort(deadline),
    retire: async pid => {
      retired.push(pid!);
      owned.exit(null, "SIGKILL");
    },
  });

  await assert.rejects(process.stop());
  assert.deepEqual(retired, [owned.process.pid]);
  assert.equal(process.exited, true);
});

test("a stuck shutdown send cannot hide the graceful deadline", async () => {
  const owned = child();
  owned.process.send = () => true;
  let retired = false;
  const process = new IsolatedWorkbenchProcess("host", owned.process, {
    gracefulSignal: () => AbortSignal.abort(new Error("shutdown expired")),
    retire: async () => { retired = true; owned.exit(null, "SIGKILL"); },
  });
  const stopped = process.stop();
  void stopped.catch(() => {});
  // Flush promise continuations, not a timer or a race against wall-clock time.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retired, true, "retirement must not await the IPC callback");
  await assert.rejects(stopped);
});

test("concurrent cleanup requests share one retirement", async () => {
  const owned = child();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const process = new IsolatedWorkbenchProcess("daemon", owned.process, {
    retire: async () => { calls += 1; await gate; owned.exit(null, "SIGKILL"); },
  });

  const first = process.stop(true);
  const second = process.stop(true);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("graceful exit wins even when its IPC acknowledgement never arrives", async () => {
  const owned = child();
  const controller = new AbortController();
  owned.process.send = () => { queueMicrotask(() => owned.exit()); return true; };
  let forced = false;
  const process = new IsolatedWorkbenchProcess("app", owned.process, {
    gracefulSignal: () => controller.signal,
    retire: async () => { forced = true; },
  });
  let settled = false;
  const stopped = process.stop().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, "exit must complete cleanup without an IPC acknowledgement");
  await stopped;
  assert.equal(forced, false);
});

test("an already closing IPC channel can still complete graceful shutdown", async () => {
  const owned = child();
  Object.defineProperty(owned.process, "connected", { value: false });
  let forced = false;
  const process = new IsolatedWorkbenchProcess("app", owned.process, {
    gracefulSignal: () => new AbortController().signal,
    retire: async () => { forced = true; owned.exit(null, "SIGKILL"); },
  });
  const stopped = process.stop();
  void stopped.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forced, false, "IPC disconnection is not proof that shutdown failed");
  owned.exit();
  await stopped;
});

test("forced retirement waits for observed child exit before completing cleanup", async () => {
  const owned = child();
  const process = new IsolatedWorkbenchProcess("daemon", owned.process, { retire: async () => {} });
  let settled = false;
  const stopped = process.stop(true).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "retirement-command completion cannot race process-exit observation");
  owned.exit(null, "SIGKILL");
  await stopped;
});

test("failed retirement preserves both shutdown and termination failures", async () => {
  const owned = child();
  const termination = new Error("permission denied");
  const process = new IsolatedWorkbenchProcess("host", owned.process, {
    gracefulSignal: () => AbortSignal.abort(new Error("shutdown expired")),
    retire: async () => { throw termination; },
  });

  await assert.rejects(process.stop(), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.includes(termination));
    assert.equal(process.exited, false);
    return true;
  });
});

test("spawn failure and early exit report the owning process and bounded output", () => {
  const owned = child();
  const process = new IsolatedWorkbenchProcess("host", owned.process);
  owned.process.stderr!.emit("data", Buffer.from(`discarded\n${"x".repeat(13_000)}\nlast host phase`));
  const failure = new Error("spawn failed");
  owned.process.emit("error", failure);

  assert.throws(() => process.assertRunning(), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, failure);
    assert.doesNotMatch(error.message, /discarded/u);
    assert.match(error.message, /last host phase/u);
    return true;
  });
  const exited = child();
  const stopped = new IsolatedWorkbenchProcess("app", exited.process);
  exited.exit(1);
  assert.throws(() => stopped.assertRunning(), /exited 1/u);
});

test("expired shutdown actually retires a real child and its descendant", async context => {
  const descendant = `
    const http = require("node:http");
    const server = http.createServer((_request, response) => {
      response.end(); server.close();
      if (process.connected) process.disconnect();
    });
    server.listen(0, "127.0.0.1", () => process.send({ pid: process.pid, port: server.address().port }));
  `;
  const script = `
    const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}],
      { stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });
    child.on("message", message => process.send(message));
    process.on("message", () => {});
    process.stdin.resume();
  `;
  const owned = spawn(process.execPath, ["-e", script], {
    ...createSpawnOptions(process.cwd(), process.env, true),
    windowsVerbatimArguments: false,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const processOwner = new IsolatedWorkbenchProcess("unresponsive fixture", owned, {
    gracefulSignal: () => AbortSignal.abort(new Error("test-controlled grace expiry")),
  });
  let descendantAddress: { pid: number; port: number } | undefined;
  const closed = once(owned, "close", { signal: context.signal });
  void closed.catch(() => {});
  try {
    const [message] = await once(owned, "message", { signal: context.signal });
    descendantAddress = message as { pid: number; port: number };
    await assert.rejects(processOwner.stop(), /force-retired/u);
    await closed;
    assert.throws(() => process.kill(descendantAddress!.pid, 0), { code: "ESRCH" });
  } finally {
    // Independent cleanup makes a failing regression safe to run.
    if (descendantAddress) {
      await fetch(`http://127.0.0.1:${descendantAddress.port}/close`).catch(error => {
        if (error.cause?.code !== "ECONNREFUSED") throw error;
      });
    }
    if (owned.connected) owned.disconnect();
    if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL");
    owned.stdin?.destroy();
  }
});
