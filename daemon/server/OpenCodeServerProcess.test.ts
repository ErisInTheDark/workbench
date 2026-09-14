/*
 * Keywords: OpenCode process, readiness, cancellation, retirement.
 * No exports. Tests exercise the owned child boundary without spawning a provider.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import OpenCodeServerProcess from "./OpenCodeServerProcess";

function childProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

test("readiness can span chunks and close waits for the owned process exit", async () => {
  const child = childProcess();
  let terminate!: () => void;
  const called = new Promise<void>(resolve => { terminate = resolve; });
  const owner = new OpenCodeServerProcess({
    createChild: () => child as unknown as ChildProcess,
    terminateChild: async () => { terminate(); },
  });
  const ready = owner.start();
  child.stdout.emit("data", Buffer.from("opencode server list"));
  child.stdout.emit("data", Buffer.from("ening on http://127.0.0.1:4096\n"));
  assert.equal(await ready, "http://127.0.0.1:4096");
  let closed = false;
  const closing = owner.close().then(() => { closed = true; });
  await called;
  assert.equal(closed, false);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  await closing;
  await assert.rejects(owner.start(), /closed/u);
});

test("abort during readiness retires the already-owned process before startup rejects", async () => {
  const child = childProcess();
  const controller = new AbortController();
  let retired = false;
  const owner = new OpenCodeServerProcess({
    signal: controller.signal,
    createChild: () => child as unknown as ChildProcess,
    terminateChild: async () => {
      retired = true;
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
    },
  });
  const starting = owner.start();
  const rejected = assert.rejects(starting, /cancel readiness/u);
  controller.abort(new Error("cancel readiness"));
  await rejected;
  assert.equal(retired, true);
});

test("retirement failure remains visible and its child remains available for a retry", async () => {
  const child = childProcess();
  let attempts = 0;
  const owner = new OpenCodeServerProcess({
    createChild: () => child as unknown as ChildProcess,
    terminateChild: async () => {
      if (++attempts === 1) throw new Error("termination denied");
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
    },
  });
  const ready = owner.start();
  child.stdout.emit("data", Buffer.from("opencode server listening on http://127.0.0.1:4096\n"));
  await ready;
  await assert.rejects(owner.close(), /termination denied/u);
  await owner.close();
  assert.equal(attempts, 2);
});
