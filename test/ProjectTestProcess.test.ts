/* No exports. Protect externally enforced expiry, cancellation and confirmed retirement before completion. */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import ProjectTestProcess from "./ProjectTestProcess";
import { killProcessTreeAsync } from "../daemon/server/process-helpers";

function fixture() {
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, signalCode: null }) as ChildProcess;
  const controller = new AbortController();
  const retired = Promise.withResolvers<void>();
  const messages: string[] = [];
  let expire = () => {};
  let cleared = 0;
  let retireCount = 0;
  const owner = new ProjectTestProcess(child, "owned.test.ts", {
    timeoutMs: 100, signal: controller.signal, report: message => messages.push(message),
    schedule: callback => { expire = callback; return () => { cleared++; }; },
    retire: async pid => { assert.equal(pid, child.pid); retireCount++; await retired.promise; },
  });
  return { child, controller, retired, owner, messages, expire: () => expire(),
    retireCount: () => retireCount, cleared: () => cleared };
}

test("expiry owns retirement once and cannot settle before the process tree is gone", async () => {
  const f = fixture();
  let finished = false;
  const result = f.owner.wait().then(value => { finished = true; return value; });
  f.expire(); f.controller.abort();
  f.child.emit("exit", 1, null);
  await Promise.resolve();
  assert.equal(f.retireCount(), 1);
  assert.equal(finished, false);
  f.retired.resolve();
  assert.deepEqual(await result, { exitCode: 1, signal: null });
  assert.ok(f.messages.some(message => message.includes("owned.test.ts") && message.includes("4321")));
  assert.equal(f.child.listenerCount("exit"), 0);
  assert.ok(f.cleared() > 0);
});

test("normal exit cancels expiry and spawn failure propagates without retiring a nonexistent process", async () => {
  const f = fixture();
  const result = f.owner.wait();
  f.child.emit("exit", 0, null);
  assert.deepEqual(await result, { exitCode: 0, signal: null });
  f.expire(); f.controller.abort();
  assert.equal(f.retireCount(), 0);
  const failed = fixture();
  Object.assign(failed.child, { pid: undefined });
  const waiting = failed.owner.wait();
  failed.child.emit("error", new Error("spawn failed"));
  await assert.rejects(waiting, /spawn failed/);
  assert.equal(failed.retireCount(), 0);
});

test("cancellation and retirement failure remain failed outcomes", async () => {
  const f = fixture();
  const waiting = f.owner.wait();
  f.controller.abort();
  f.retired.resolve();
  assert.deepEqual(await waiting, { exitCode: 130, signal: null });
  const failed = fixture();
  const result = failed.owner.wait();
  failed.expire();
  failed.retired.reject(new Error("retirement failed"));
  await assert.rejects(result, error => error instanceof Error && error.cause instanceof Error
    && error.cause.message === "retirement failed");
});

test("the parent can retire a real worker whose event loop cannot run its own timeout", async context => {
  const child = spawn(process.execPath, ["-e", `
    process.stdout.write("ready\\n");
    setImmediate(() => { for (;;) {} });
  `], { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const exited = once(child, "exit");
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await killProcessTreeAsync(child.pid);
  });
  let expire = () => {};
  const result = new ProjectTestProcess(child, "blocked-worker", {
    timeoutMs: 100, schedule: callback => { expire = callback; return () => {}; }, report: () => {},
  }).wait();
  await once(child.stdout!, "data");
  expire();
  assert.deepEqual(await result, { exitCode: 1, signal: null });
  await exited;
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
