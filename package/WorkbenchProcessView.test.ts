/*
 * No production exports. Protect keyboard stop intent versus terminal detachment.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import WorkbenchProcessView from "./WorkbenchProcessView.ts";

class Terminal extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean) { this.isRaw = value; return this; }
}

function event() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(target: "app" | "daemon" | "all") {
  const input = new Terminal();
  const attached = event();
  const daemonStopped = event();
  const calls: string[] = [];
  const view = new WorkbenchProcessView({
    target, input,
    write: async text => { if (text.includes("Viewing")) attached.resolve(); },
    warn: message => assert.fail(message),
    createFollower: () => ({ start: async () => {}, close: async () => { calls.push("unfollow"); } }),
    connect: async () => ({
      logDirectory: "/unused", logPrefix: target === "app" ? "workbench-app" : "workbench-host",
      stopDaemon: async () => { calls.push("daemon"); daemonStopped.resolve(); },
      stopHost: async () => { calls.push("host"); },
      quitApp: async () => { calls.push("app"); },
      close: async () => { calls.push("detach"); },
    }),
  });
  return { input, view, attached, daemonStopped, calls };
}

test("q, terminal EOF and external detachment never stop the viewed process", async () => {
  for (const cause of ["q", "eof", "external"]) {
    const f = fixture("daemon");
    const running = f.view.run();
    await f.attached.promise;
    // Wait for run's same-turn listener installation after its awaited output.
    await Promise.resolve();
    if (cause === "q") f.input.write("q");
    else if (cause === "eof") f.input.end();
    else f.view.detach();
    await running;
    assert.deepEqual(f.calls.sort(), ["detach", "unfollow"]);
    assert.equal(f.input.isRaw, false);
  }
});

test("daemon Ctrl+C requests ordered daemon then host shutdown", async () => {
  const f = fixture("daemon");
  const running = f.view.run();
  await f.attached.promise;
  await Promise.resolve();
  f.input.write("\u0003\u0003");
  await running;
  assert.deepEqual(f.calls.slice(0, 2), ["daemon", "host"]);
  assert.equal(f.input.isRaw, false);
});

for (const target of ["app", "all"] as const) test(`${target} Ctrl+C invokes only app Quit`, async () => {
  const f = fixture(target);
  const running = f.view.run();
  await f.attached.promise;
  await Promise.resolve();
  f.input.write("\u0003");
  await running;
  assert.equal(f.calls[0], "app");
  assert.ok(!f.calls.includes("daemon") && !f.calls.includes("host"));
});

test("detaching during connection cancels observation without sending stop", async () => {
  const connecting = event();
  const input = new Terminal();
  const view = new WorkbenchProcessView({
    target: "daemon", input, write: async () => {}, warn: message => assert.fail(message),
    connect: signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      connecting.resolve();
    }),
  });
  const running = view.run();
  await connecting.promise;
  view.detach();
  await running;
  assert.equal(input.isRaw, false);
});
