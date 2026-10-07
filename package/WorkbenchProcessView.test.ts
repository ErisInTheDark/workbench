/*
 * No production exports. Protect detachable key handling, always-on logging and lifecycle intent routing.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import WorkbenchProcessView from "./WorkbenchProcessView.ts";
import type { ProcessViewControls, ProcessViewControlsSnapshot } from "./WorkbenchProcessViewControls.ts";

class Terminal extends PassThrough {
  isTTY = true;
  isRaw = false;
  ready: () => void = () => {};
  setRawMode(value: boolean) { this.isRaw = value; return this; }
  resume() { this.ready(); return super.resume(); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

const LIFECYCLE_CALLS = ["daemon", "host", "force", "app", "start"];

function fixture(options: {
  snapshot?: ProcessViewControlsSnapshot;
  failHost?: boolean;
  openControls?: (warn: (message: string) => void) => Promise<ProcessViewControls>;
  isTTY?: boolean;
} = {}) {
  const input = new Terminal();
  input.isTTY = options.isTTY ?? true;
  const attached = deferred();
  input.ready = attached.resolve;
  const calls: string[] = [];
  const notices: string[] = [];
  const legends: string[] = [];
  const snapshot = options.snapshot ?? { host: true, daemon: true, app: true };
  const controls: ProcessViewControls = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    killDaemon: async () => { calls.push("daemon"); },
    killHost: async () => { calls.push("host"); if (options.failHost) throw new Error("host stop failed"); },
    forceStopHost: async () => { calls.push("force"); },
    killApp: async () => { calls.push("app"); },
    startApp: async () => { calls.push("start"); },
    close: async () => { calls.push("close-controls"); },
  };
  const view = new WorkbenchProcessView({
    input,
    write: async () => {},
    warn: message => { notices.push(message); },
    logDirectory: "/unused",
    prefixes: ["workbench-app"],
    openControls: options.openControls ?? (async () => controls),
    createFollower: () => ({
      start: async () => { calls.push("follow"); },
      close: async () => { calls.push("unfollow"); },
    }),
    createStatusLine: () => ({
      enabled: true,
      install: () => {},
      update: text => { legends.push(text); },
      notice: text => { notices.push(text); },
      close: () => {},
    }),
  });
  return { input, view, attached, calls, notices, legends, snapshot, controls };
}

for (const cause of ["q", "ctrl-c", "eof", "external"] as const) {
  test(`${cause} detachment never invokes lifecycle controls`, async () => {
    const f = fixture();
    const running = f.view.run();
    await f.attached.promise;
    if (cause === "q") f.input.write("q");
    else if (cause === "ctrl-c") f.input.write("\u0003");
    else if (cause === "eof") f.input.end();
    else f.view.detach();
    await running;
    assert.ok(!f.calls.some(call => LIFECYCLE_CALLS.includes(call)));
    assert.equal(f.input.isRaw, false);
  });
}

test("logs and controls start even when no process is running", async () => {
  const f = fixture({ snapshot: { host: false, daemon: false, app: false } });
  const running = f.view.run();
  await f.attached.promise;
  assert.ok(f.calls.includes("follow"));
  assert.ok(!f.calls.includes("close-controls"));
  f.view.detach();
  await running;
});

test("a failing control connection still leaves logs running", async () => {
  const f = fixture({ openControls: async () => { throw new Error("app not running"); } });
  const running = f.view.run();
  await f.attached.promise;
  assert.ok(f.calls.includes("follow"));
  assert.match(f.notices.join("\n"), /controls are unavailable/u);
  f.view.detach();
  await running;
});

test("d, h, a and s route to the matching control without detaching", async () => {
  const f = fixture();
  const running = f.view.run();
  await f.attached.promise;
  for (const key of ["d", "h", "a"]) f.input.write(key);
  await flush();
  f.snapshot.app = false;
  f.input.write("s");
  await flush();
  assert.deepEqual(f.calls.filter(call => LIFECYCLE_CALLS.includes(call)), ["daemon", "host", "app", "start"]);
  assert.equal(f.input.isRaw, true);
  f.view.detach();
  await running;
});

test("unavailable lifecycle keys warn instead of acting", async () => {
  const f = fixture({ snapshot: { host: false, daemon: false, app: false } });
  const running = f.view.run();
  await f.attached.promise;
  for (const key of ["d", "h", "a"]) f.input.write(key);
  await flush();
  assert.ok(!f.calls.some(call => LIFECYCLE_CALLS.includes(call)));
  assert.match(f.notices.join("\n"), /unavailable/u);
  f.view.detach();
  await running;
});

test("a failed kill host arms force halt for the next h", async () => {
  const f = fixture({ failHost: true });
  const running = f.view.run();
  await f.attached.promise;
  f.input.write("h");
  await flush();
  assert.deepEqual(f.calls.filter(call => call === "host" || call === "force"), ["host"]);
  assert.match(f.notices.join("\n"), /force-halt armed/u);
  f.input.write("h");
  await flush();
  assert.deepEqual(f.calls.filter(call => call === "host" || call === "force"), ["host", "force"]);
  f.view.detach();
  await running;
});

test("non-interactive views follow logs and skip raw input", async () => {
  const f = fixture({ isTTY: false });
  const running = f.view.run();
  await flush();
  assert.ok(f.calls.includes("follow"));
  assert.equal(f.input.isRaw, false);
  f.view.detach();
  await running;
});
