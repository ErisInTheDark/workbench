/*
 * No production exports. Protect that each daemon run is born inside its own container and that disposal empties it.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import DaemonProcessContainer from "./DaemonProcessContainer.ts";

function fakeProcess(pid: number) {
  const child = new EventEmitter() as ChildProcess;
  let exitCode: number | null = null;
  Object.defineProperties(child, {
    pid: { value: pid },
    exitCode: { get: () => exitCode },
    signalCode: { value: null },
    connected: { value: true },
  });
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.once("exit", (code: number | null) => { exitCode = code; });
  return child;
}

test("linux runs the daemon in a scope bound to the host unit and empties it after the daemon exited", async () => {
  const launches: string[][] = [];
  const commands: string[][] = [];
  let treeKills = 0;
  const container = new DaemonProcessContainer({
    root: "/checkout", environment: {}, platform: "linux", warn: message => assert.fail(message),
    hostUnit: () => "workbench-host.service",
    killTree: async () => { treeKills++; },
    run: async (command, args) => {
      commands.push([command, ...args]);
      if (args.includes("stop")) throw new Error("Failed to stop unit: Unit workbench-daemon-x.scope not loaded.");
    },
    spawn: ((command: string, args: string[]) => { launches.push([command, ...args]); return fakeProcess(41); }) as never,
  });
  const daemon = container.spawn("node", ["server/index.ts"], {});
  const [launcher, ...launchArgs] = launches[0]!;
  assert.equal(launcher, "systemd-run");
  assert.ok(launchArgs.includes("--scope"));
  assert.ok(launchArgs.includes("--property=BindsTo=workbench-host.service"), "host loss must end the daemon scope");
  assert.deepEqual(launchArgs.slice(launchArgs.indexOf("--") + 1), ["node", "server/index.ts"]);
  const scope = launchArgs.find(arg => arg.startsWith("--unit="))!.slice("--unit=".length);
  daemon.emit("exit", 1, null);
  await container.dispose();
  assert.ok(commands.some(command => command.includes("kill") && command.includes("--signal=SIGKILL") && command.includes(scope)));
  assert.equal(treeKills, 0, "the scope, not a tree walk, owns an exited daemon's orphans");
});

test("windows acknowledges the daemon only after its job holder owns it, and disposal ends the holder", async () => {
  const daemon = fakeProcess(42);
  const holder = fakeProcess(43);
  const sent: object[] = [];
  Object.assign(daemon, { send(message: object, done: (error: Error | null) => void) { sent.push(message); done(null); return true; } });
  let daemonEnvironment: NodeJS.ProcessEnv | undefined;
  let holderArgs: string[] = [];
  const container = new DaemonProcessContainer({
    root: "C:/checkout", environment: {}, platform: "win32", warn: message => assert.fail(message),
    killTree: async () => assert.fail("The job, not a tree walk, ends an owned daemon."),
    holderExecutable: async () => "holder.exe",
    spawn: ((command: string, args: string[], options: SpawnOptions) => {
      if (command === "holder.exe") { holderArgs = args; return holder; }
      daemonEnvironment = options.env;
      return daemon;
    }) as never,
  });
  container.spawn("node", ["server/index.ts"], { env: { KEEP: "1" } });
  assert.equal(daemonEnvironment?.WORKBENCH_DAEMON_ACK_REQUIRED, "1");
  assert.equal(daemonEnvironment?.KEEP, "1");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(holderArgs, ["job-hold", "42"]);
  assert.deepEqual(sent, [], "the daemon must not start before the job holds it");
  (holder.stdout as PassThrough).write("owned\r\n");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [{ type: "workbench-daemon-owned" }]);
  holder.stdin!.on("finish", () => { daemon.emit("exit", 1, null); holder.emit("exit", 0, null); });
  await container.dispose();
  assert.equal(holder.exitCode, 0);
});

test("windows holder failure ends the unacknowledged daemon and reports why", async () => {
  const daemon = fakeProcess(42);
  const holder = fakeProcess(43);
  const warnings: string[] = [];
  let killed = false;
  Object.assign(daemon, {
    send: () => assert.fail("A daemon without a job must never be acknowledged."),
    kill: () => { killed = true; daemon.emit("exit", 1, null); return true; },
  });
  const container = new DaemonProcessContainer({
    root: "C:/checkout", environment: {}, platform: "win32", warn: message => warnings.push(message),
    killTree: async () => undefined,
    holderExecutable: async () => "holder.exe",
    spawn: ((command: string) => command === "holder.exe" ? holder : daemon) as never,
  });
  container.spawn("node", ["server/index.ts"], {});
  await new Promise(resolve => setImmediate(resolve));
  (holder.stderr as PassThrough).write("Access is denied.\n");
  holder.emit("exit", 1, null);
  await container.dispose();
  assert.equal(killed, true);
  assert.match(warnings.join("\n"), /Access is denied/u);
});
