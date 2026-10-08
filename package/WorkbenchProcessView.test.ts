/*
 * No production exports. Protect detachable key handling, always-on logging and lifecycle/open intent routing.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import WorkbenchProcessView from "./WorkbenchProcessView.ts";
import type { ProcessViewControls, ProcessViewControlsSnapshot } from "./WorkbenchProcessViewControls.ts";
import type { WorkbenchAppControlRuntime } from "../shared/http/workbench-app-control.ts";
import { IDLE_RELOAD_OPERATION } from "../shared/reload/workbench-reload.ts";
import { KITTY_KEYBOARD_POP, KITTY_KEYBOARD_PUSH, KITTY_KEYBOARD_QUERY } from "./terminal-key-hold.ts";

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

const LIFECYCLE_CALLS = ["daemon", "host", "force", "app", "start", "open", "reload", "pull"];

const runtime = (overrides: Partial<WorkbenchAppControlRuntime> = {}): WorkbenchAppControlRuntime => ({
  dirty: true, destructive: false, update: null, operation: IDLE_RELOAD_OPERATION, ...overrides,
});

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
  const snapshot = options.snapshot ?? { host: true, daemon: true, app: true, runtime: null };
  const clock = { now: 0 };
  const frames = new Set<() => void>();
  const terminal: string[] = [];
  const controls: ProcessViewControls = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    killDaemon: async () => { calls.push("daemon"); },
    killHost: async () => { calls.push("host"); if (options.failHost) throw new Error("host stop failed"); },
    forceStopHost: async () => { calls.push("force"); },
    killApp: async () => { calls.push("app"); },
    startApp: async () => { calls.push("start"); },
    openApp: async () => { calls.push("open"); },
    reloadAll: async () => { calls.push("reload"); },
    pullChanges: async () => { calls.push("pull"); },
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
    writeTerminal: text => { terminal.push(text); },
    now: () => clock.now,
    every: (_ms, frame) => {
      frames.add(frame);
      return () => { frames.delete(frame); };
    },
  });
  /** Advance the fake clock to `at`, running hold frames as the view's timer would. */
  const advance = (at: number) => {
    clock.now = at;
    for (const frame of [...frames]) frame();
  };
  const press = (key: string, at: number) => {
    clock.now = at;
    input.write(key);
  };
  return { input, view, attached, calls, notices, legends, snapshot, controls, terminal, frames, advance, press };
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
  const f = fixture({ snapshot: { host: false, daemon: false, app: false, runtime: null } });
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

test("d, h, o, a and s route to the matching control without detaching", async () => {
  const f = fixture();
  const running = f.view.run();
  await f.attached.promise;
  for (const key of ["d", "h", "o", "a"]) f.input.write(key);
  await flush();
  f.snapshot.app = false;
  f.input.write("s");
  await flush();
  assert.deepEqual(f.calls.filter(call => LIFECYCLE_CALLS.includes(call)), ["daemon", "host", "open", "app", "start"]);
  assert.equal(f.input.isRaw, true);
  f.view.detach();
  await running;
});

test("unavailable lifecycle keys warn instead of acting", async () => {
  const f = fixture({ snapshot: { host: false, daemon: false, app: false, runtime: null } });
  const running = f.view.run();
  await f.attached.promise;
  for (const key of ["d", "h", "a", "o"]) f.input.write(key);
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

const holdCalls = (calls: string[]) => calls.filter(call => call === "reload" || call === "pull");

/** Legacy terminal: a press, the OS repeat delay, then 30ms autorepeats until `until`. */
function autorepeat(f: ReturnType<typeof fixture>, key: string, until: number, from = 0) {
  f.press(key, from);
  let at = from + 500;
  for (; at <= from + until; at += 30) { f.press(key, at); f.advance(at + 1); }
  return at - 30;
}

test("autorepeat: holding r through the duration then releasing reloads all", async () => {
  const f = fixture({ snapshot: { host: true, daemon: true, app: true, runtime: runtime() } });
  const running = f.view.run();
  await f.attached.promise;
  const last = autorepeat(f, "r", 1_200);
  assert.deepEqual(holdCalls(f.calls), []);
  f.advance(last + 200);
  await flush();
  assert.deepEqual(holdCalls(f.calls), ["reload"]);
  assert.equal(f.frames.size, 0);
  f.view.detach();
  await running;
});

test("autorepeat: releasing early or tapping cancels without acting", async () => {
  const f = fixture({ snapshot: { host: true, daemon: true, app: true, runtime: runtime() } });
  const running = f.view.run();
  await f.attached.promise;
  const last = autorepeat(f, "r", 700);
  f.advance(last + 200);
  f.press("r", 5_000);
  f.advance(5_800);
  await flush();
  assert.deepEqual(holdCalls(f.calls), []);
  f.view.detach();
  await running;
});

test("Escape cancels a full hold, and destructive reloads need the longer hold", async () => {
  const f = fixture({ snapshot: { host: true, daemon: true, app: true, runtime: runtime({ destructive: true }) } });
  const running = f.view.run();
  await f.attached.promise;
  autorepeat(f, "r", 2_300);
  f.press("\u001b", 2_301);
  await flush();
  // Past one second but short of the destructive two: releasing cancels.
  const last = autorepeat(f, "r", 1_500, 10_000);
  f.advance(last + 200);
  await flush();
  assert.deepEqual(holdCalls(f.calls), []);
  f.view.detach();
  await running;
});

test("kitty terminals hold until the real release and restore the keyboard on detach", async () => {
  const update = { state: "available", reason: null, upstream: "origin/main", behind: 2, ahead: 0, conflicts: [],
    lockfileChanged: false, checkedAt: 0, projectId: null, failure: null } as const;
  const f = fixture({ snapshot: { host: true, daemon: true, app: true, runtime: runtime({ dirty: false, update }) } });
  const running = f.view.run();
  await f.attached.promise;
  assert.ok(f.terminal.includes(KITTY_KEYBOARD_QUERY));
  f.press("\u001b[?1u", 0);
  assert.ok(f.terminal.includes(KITTY_KEYBOARD_PUSH));
  f.press("\u001b[117u", 0);
  // No repeats arrive, yet the hold survives: kitty reports the release explicitly.
  f.advance(1_500);
  assert.deepEqual(holdCalls(f.calls), []);
  f.press("\u001b[117;1:3u", 1_600);
  await flush();
  assert.deepEqual(holdCalls(f.calls), ["pull"]);
  f.view.detach();
  await running;
  assert.equal(f.terminal.at(-1), KITTY_KEYBOARD_POP);
});

test("an unavailable hold key warns once for its whole autorepeat", async () => {
  const conflict = { state: "conflict", reason: null, upstream: "origin/main", behind: 1, ahead: 0, conflicts: ["a.ts"],
    lockfileChanged: false, checkedAt: 0, projectId: null, failure: null } as const;
  const f = fixture({ snapshot: { host: true, daemon: true, app: true, runtime: runtime({ dirty: false, update: conflict }) } });
  const running = f.view.run();
  await f.attached.promise;
  autorepeat(f, "u", 1_500);
  await flush();
  assert.deepEqual(holdCalls(f.calls), []);
  assert.equal(f.notices.filter(notice => /Pull changes is unavailable/u.test(notice)).length, 1);
  f.view.detach();
  await running;
});
