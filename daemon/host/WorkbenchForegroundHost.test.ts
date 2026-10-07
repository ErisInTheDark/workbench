/*
 * No production exports. Protect foreground ownership, verified readiness and platform launch boundaries.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test from "node:test";
import WorkbenchForegroundHost from "./WorkbenchForegroundHost.ts";
import type { WorkbenchServiceEndpoint } from "../../shared/http/workbench-service.ts";
import fs from "node:fs/promises";
import path from "node:path";

import WorkbenchTemporaryDirectory from "../../shared/WorkbenchTemporaryDirectory.ts";

const endpoint: WorkbenchServiceEndpoint = {
  version: 1, instanceId: "30e59606-6ba9-4cd6-99ac-3dbec9083650", pid: 12345,
  origin: "http://127.0.0.1:31234", token: "a".repeat(64),
};
function event() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("foreground launch refuses a verified existing host without spawning or stopping anything", async () => {
  const host = new WorkbenchForegroundHost({
    root: "/repo", dataRoot: "/data", read: async () => endpoint, verify: async () => {},
    output: () => {}, warn: message => assert.fail(message),
    spawn: () => { throw new Error("Must not spawn."); },
  });
  await assert.rejects(host.run(), /already launched.*wb view daemon/u);
});

for (const platform of ["win32", "linux"] as const) {
  test(`foreground ${platform} waits for owned readiness, wakes once and closes its owner pipe on stop`, async () => {
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.once("finish", () => child.emit("close", 0, null));
    const spawned = event();
    const woken = event();
    const intents: string[] = [];
    let readCount = 0;
    let launch: { command: string; args: string[]; options: SpawnOptions } | null = null;
    const host = new WorkbenchForegroundHost({
      root: "/repo", dataRoot: "/data", platform, environment: {},
      stage: { stage: async options => options.executable },
      output: () => {}, warn: message => assert.fail(message),
      read: async () => readCount++ === 0 ? null : endpoint,
      verify: async () => {},
      spawn: (command, args, options) => { launch = { command, args, options }; spawned.resolve(); return child; },
      createControl: () => ({
        start: async () => {},
        request: async intent => {
          intents.push(intent.method);
          if (intent.method === "service/daemon/wake") woken.resolve();
          return { kind: "ok", id: endpoint.instanceId };
        },
        close: async () => {},
      }),
    });
    const running = host.run();
    await spawned.promise;
    assert.deepEqual(intents, []);
    child.stdout.emit("data", Buffer.from(`\u001eWORKBENCH_HOST_V1 ${JSON.stringify({ pid: endpoint.pid })}\n`));
    await woken.promise;
    await host.stop();
    await running;
    assert.deepEqual(intents, ["service/daemon/wake", "service/stop"]);
    assert.ok(child.stdin.writableEnded);
    if (platform === "linux") {
      const configuration = launch as { command: string; args: string[]; options: SpawnOptions } | null;
      assert.equal(configuration?.command, "systemd-run");
      assert.ok(configuration?.args.includes("--pipe"));
      assert.ok(configuration?.args.includes("--property=KillMode=mixed"));
      assert.ok(!configuration?.args.includes("enable"));
    }
  });
}

test("replacement keeps foreground ownership when the retired control cannot close cleanly", async () => {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.once("finish", () => child.emit("close", 0, null));
  const wakes = [event(), event()];
  const spawned = event();
  const closeAttempted = event();
  const warned = event();
  const warnings: string[] = [];
  let readCount = 0;
  let controls = 0;
  const replacement = { ...endpoint, instanceId: "30e59606-6ba9-4cd6-99ac-3dbec9083651", pid: 12346 };
  const host = new WorkbenchForegroundHost({
    root: "/repo", dataRoot: "/data", platform: "win32", environment: {},
    stage: { stage: async options => options.executable },
    output: () => {}, warn: message => { warnings.push(message); warned.resolve(); },
    read: async () => readCount++ === 0 ? null : readCount === 2 ? endpoint : replacement,
    verify: async () => {},
    spawn: () => { spawned.resolve(); return child; },
    createControl: () => {
      const generation = controls++;
      return {
        start: async () => {},
        request: async intent => {
          if (intent.method === "service/daemon/wake") wakes[generation]?.resolve();
          return { kind: "ok" as const, id: endpoint.instanceId };
        },
        close: async () => {
          if (generation === 0) {
            closeAttempted.resolve();
            throw new Error("retired endpoint vanished");
          }
        },
      };
    },
  });
  const running = host.run();
  void running.catch(() => {});
  try {
    await spawned.promise;
    child.stdout.emit("data", Buffer.from(`\u001eWORKBENCH_HOST_V1 ${JSON.stringify({ pid: endpoint.pid })}\n`));
    await wakes[0]!.promise;
    child.stdout.emit("data", Buffer.from(`\u001eWORKBENCH_HOST_V1 ${JSON.stringify({ pid: replacement.pid })}\n`));
    await closeAttempted.promise;
    await warned.promise;
    assert.equal(child.stdin.writableEnded, false);
    await wakes[1]!.promise;
    assert.ok(warnings.some(message => message.includes("retired endpoint vanished")));
    await host.stop();
    await running;
  } finally {
    child.stdin.end();
  }
});

test("a failed daemon wake leaves the verified foreground host available for retry", async () => {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.once("finish", () => child.emit("close", 0, null));
  const attempted = event();
  const spawned = event();
  const warned = event();
  const warnings: string[] = [];
  let readCount = 0;
  const host = new WorkbenchForegroundHost({
    root: "/repo", dataRoot: "/data", platform: "win32", environment: {},
    stage: { stage: async options => options.executable },
    output: () => {}, warn: message => { warnings.push(message); warned.resolve(); },
    read: async () => readCount++ === 0 ? null : endpoint,
    verify: async () => {},
    spawn: () => { spawned.resolve(); return child; },
    createControl: () => ({
      start: async () => {},
      request: async intent => {
        if (intent.method === "service/daemon/wake") {
          attempted.resolve();
          throw new Error("daemon startup failed");
        }
        return { kind: "ok" as const, id: endpoint.instanceId };
      },
      close: async () => {},
    }),
  });
  const running = host.run();
  void running.catch(() => {});
  try {
    await spawned.promise;
    child.stdout.emit("data", Buffer.from(`\u001eWORKBENCH_HOST_V1 ${JSON.stringify({ pid: endpoint.pid })}\n`));
    await attempted.promise;
    await warned.promise;
    assert.equal(child.stdin.writableEnded, false);
    assert.ok(warnings.some(message => message.includes("daemon startup failed")));
    await host.stop();
    await running;
  } finally {
    child.stdin.end();
  }
});

test("foreground emergency input closes its owner pipe while graceful control is stuck", async () => {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.once("finish", () => child.emit("close", 0, null));
  const spawned = event();
  const woken = event();
  const stopping = event();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let readCount = 0;
  const host = new WorkbenchForegroundHost({
    root: "/repo", dataRoot: "/data", platform: "win32", environment: {},
    stage: { stage: async options => options.executable },
    output: () => {}, warn: message => assert.fail(message),
    read: async () => readCount++ === 0 ? null : endpoint,
    verify: async () => {},
    spawn: () => { spawned.resolve(); return child; },
    createControl: () => ({
      start: async () => {},
      request: async intent => {
        if (intent.method === "service/daemon/wake") woken.resolve();
        if (intent.method === "service/stop") { stopping.resolve(); await pending; }
        return { kind: "ok", id: endpoint.instanceId };
      },
      close: async () => {},
    }),
  });
  const running = host.run();
  try {
    await spawned.promise;
    child.stdout.emit("data", Buffer.from(`\u001eWORKBENCH_HOST_V1 ${JSON.stringify({ pid: endpoint.pid })}\n`));
    await woken.promise;
    const graceful = host.stop();
    await stopping.promise;
    assert.equal(child.stdin.writableEnded, false);
    host.forceStop();
    assert.equal(child.stdin.writableEnded, true);
    release();
    await graceful;
    await running;
  } finally {
    release();
    child.stdin.end();
  }
});

test("the committed Windows supervisor retires its real foreground fixture when its owner pipe closes", {
  skip: process.platform !== "win32",
}, async context => {
  const temporary = await WorkbenchTemporaryDirectory.create("wb-foreground-native-");
  const root = temporary.path;
  const dataRoot = path.join(root, "data");
  const native = path.join("daemon", "host", "bin", `windows-${process.arch}`, "workbench-daemon-host.exe");
  await fs.mkdir(path.dirname(path.join(root, native)), { recursive: true });
  await fs.copyFile(path.resolve(import.meta.dirname, "../..", native), path.join(root, native));
  await fs.writeFile(path.join(root, "daemon", "host", "launch-node.mjs"), `
    import http from "node:http";
    import fs from "node:fs/promises";
    import path from "node:path";
    import { randomUUID } from "node:crypto";
    import { spawn } from "node:child_process";
    let ack = "";
    for await (const bytes of process.stdin) ack += bytes;
    if (ack !== "workbench-host-owned\\n") throw new Error("Missing ownership acknowledgement");
    const child = spawn(process.execPath, ["-e", "process.send({pid:process.pid});process.stdin.resume()"], {stdio:["pipe","ignore","ignore","ipc"]});
    const descendant = await new Promise(resolve => child.once("message", resolve));
    await fs.mkdir(process.env.WORKBENCH_DATA_ROOT, {recursive:true});
    await fs.writeFile(path.join(process.env.WORKBENCH_DATA_ROOT, "descendant.json"), JSON.stringify(descendant));
    const instanceId = randomUUID();
    let endpoint;
    const server = http.createServer((request, response) => {
      if (request.headers.authorization !== "Bearer " + "a".repeat(64)) { response.writeHead(403); response.end(); return; }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(endpoint));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    endpoint = {version:1,instanceId,pid:process.pid,origin:"http://127.0.0.1:"+server.address().port};
    const directory = path.join(process.env.WORKBENCH_DATA_ROOT, "service");
    await fs.mkdir(directory, {recursive:true});
    await fs.writeFile(path.join(directory,"runtime.json"), JSON.stringify({...endpoint,token:"a".repeat(64)}));
    process.stdout.write("workbench-host-ready\\n");
  `);
  const ready = event();
  const output: string[] = [];
  const host = new WorkbenchForegroundHost({
    root, dataRoot, output: text => output.push(text), warn: message => output.push(message),
    createControl: () => ({
      start: async () => {},
      request: async intent => {
        if (intent.method === "service/daemon/wake") ready.resolve();
        return { kind: "ok", id: endpoint.instanceId };
      },
      close: async () => {},
    }),
  });
  context.after(async () => { await host.stop(); await temporary.dispose(); });
  const running = host.run();
  await Promise.race([ready.promise, running.then(() => { throw new Error("Foreground fixture exited before readiness."); })]);
  const descendant = JSON.parse(await fs.readFile(path.join(dataRoot, "descendant.json"), "utf8")) as { pid: number };
  process.kill(descendant.pid, 0);
  await host.stop();
  await running;
  assert.throws(() => process.kill(descendant.pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
});
