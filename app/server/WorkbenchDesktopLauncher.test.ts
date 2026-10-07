/*
 * No production exports. Node tests protect committed-artifact launch, startup-failure reporting, shortcut installation, and platform scope.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import test from "node:test";

import WorkbenchDesktopLauncher, { TRAY_READY_SENTINEL } from "./WorkbenchDesktopLauncher.ts";

class FakeOutput extends EventEmitter {
  destroy() { return this; }
  send(text: string) { this.emit("data", Buffer.from(text, "utf8")); }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeOutput();
  readonly stderr = new FakeOutput();
  readonly pid = 4242;
  unref() {}
  exit(code: number | null, signal: NodeJS.Signals | null = null) { this.emit("exit", code, signal); }
  fail(error: Error) { this.emit("error", error); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: {
  child?: FakeChild;
  handoff?: (handoff: () => void) => () => void;
  launcherExists?: boolean;
  platform?: NodeJS.Platform;
  stage?: (executable: string) => string;
} = {}) {
  const calls: Array<{ args: string[]; command: string; detached?: boolean; stdio?: unknown }> = [];
  const child = options.child ?? new FakeChild();
  const spawned = deferred();
  const root = path.resolve("C:/workbench");
  const launcher = new WorkbenchDesktopLauncher({
    pathExists: async () => options.launcherExists ?? true,
    platform: options.platform ?? "win32",
    repositoryRootPath: root,
    spawnProcess: (command, args, spawnOptions) => {
      calls.push({ command, args, detached: spawnOptions.detached, stdio: spawnOptions.stdio });
      spawned.resolve();
      return child as unknown as ChildProcess;
    },
    stage: { stage: async request => options.stage ? options.stage(request.executable) : request.executable },
    startupHandoff: options.handoff ?? (handoff => { handoff(); return () => {}; }),
    runCommand: async (command, args) => {
      calls.push({ command, args });
    },
  });
  return { calls, child, launcher, root, spawned: spawned.promise };
}

test("launches the existing native owner detached without rebuilding it", async () => {
  const target = fixture();
  await target.launcher.start();
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0]?.detached, true);
  assert.deepEqual(target.calls[0]?.stdio, ["ignore", "pipe", "pipe"]);
  assert.match(target.calls[0]?.command ?? "", /tray[\\/]bin[\\/]windows-x64[\\/]workbench-tray\.exe$/u);
  assert.deepEqual(target.calls[0]?.args, ["--workbench-root", target.root]);
});

test("launches a staged copy of the committed launcher", async () => {
  const staged = path.resolve("C:/data/native/tray/workbench-tray.exe");
  const target = fixture({ stage: () => staged });
  await target.launcher.start();
  assert.equal(target.calls[0]?.command, staged);
  assert.deepEqual(target.calls[0]?.args, ["--workbench-root", target.root]);
});

test("reports a tray that dies during startup with its captured diagnostics", async () => {
  const target = fixture({ handoff: () => () => {} });
  const started = target.launcher.start();
  await target.spawned;
  target.child.stderr.send("error while loading shared libraries: libwebkit2gtk-4.1.so.0\n");
  target.child.exit(1);
  await assert.rejects(started, /libwebkit2gtk-4\.1/u);
});

test("resolves once the tray signals readiness", async () => {
  const target = fixture({ handoff: () => () => {} });
  const started = target.launcher.start();
  await target.spawned;
  target.child.stdout.send(`${TRAY_READY_SENTINEL}\n`);
  await started;
});

test("hands off a living tray that never signals readiness", async () => {
  const target = fixture();
  await target.launcher.start();
  assert.equal(target.calls[0]?.detached, true);
});

test("rejects when the tray fails to spawn", async () => {
  const target = fixture({ handoff: () => () => {} });
  const started = target.launcher.start();
  await target.spawned;
  target.child.fail(new Error("spawn ENOENT"));
  await assert.rejects(started, /ENOENT/u);
});

test("shortcut installation invokes only the Windows adapter", async () => {
  const target = fixture();
  await target.launcher.installShortcut();
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0]?.command, "powershell.exe");
  assert.equal(target.calls.some((call) => call.detached), false);
});

test("reports a missing committed launcher without trying to build it", async () => {
  const target = fixture({ launcherExists: false });
  await assert.rejects(target.launcher.start(), /Restore the committed artifact or run pnpm build:tray/u);
  assert.deepEqual(target.calls, []);
});

test("rejects shortcut ownership on unsupported desktop platforms", async () => {
  const target = fixture({ platform: "darwin" });
  await assert.rejects(target.launcher.installShortcut(), /Windows|Linux/u);
  assert.deepEqual(target.calls, []);
});
