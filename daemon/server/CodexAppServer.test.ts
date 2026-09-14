/*
 * No production exports. Node tests protect Codex native prompt suppression, asynchronous shutdown, and intentional child replacement from stale callbacks.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import CodexAppServer, { getCodexAppServerArgs } from "./CodexAppServer";

function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    killed: boolean;
    pid: number;
    stderr: PassThrough;
    stdin: PassThrough;
    stdout: PassThrough;
  };
  child.killed = false;
  child.pid = pid;
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  return child as unknown as ChildProcess;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

test("app-server arguments suppress Codex-owned prompt and tool systems", () => {
  const args = getCodexAppServerArgs();
  const requiredConfigs = [
    "skills.include_instructions=false",
    "include_apps_instructions=false",
    "include_collaboration_mode_instructions=false",
    "features.apps=false",
    "features.plugins=false",
    "features.multi_agent=false",
    "features.multi_agent_v2=false",
    "agents.enabled=false",
  ];

  for (const config of requiredConfigs) {
    const index = args.indexOf(config);
    assert.notEqual(index, -1, `missing ${config}`);
    assert.equal(args[index - 1], "--config");
  }
  assert.deepEqual(args.slice(-3), ["app-server", "--listen", "stdio://"]);
});

test("intentional replacement ignores stale child output and exit", async () => {
  const first = fakeChild(101);
  const second = fakeChild(102);
  const children = [first, second];
  const fatalReasons: string[] = [];
  const lifecycleErrors: string[] = [];
  const lifecycleLogs: string[] = [];
  const messages: unknown[] = [];
  const terminated: ChildProcess[] = [];
  const server = new CodexAppServer({
    createChild: () => children.shift() ?? second,
    log: (name, message) => lifecycleLogs.push(`[${name}] ${message}`),
    logError: (name, message) => lifecycleErrors.push(`[${name}] ${message}`),
    onFatalExit: (reason) => fatalReasons.push(reason),
    onMessage: (message) => messages.push(message),
    projectRoot: "C:/workspace",
    terminateChildAsync: async (child) => {
      terminated.push(child);
      (child as unknown as { killed: boolean }).killed = true;
    },
  });

  server.send({ method: "first" });
  await server.stop();
  server.send({ method: "second" });
  first.stdout?.emit("data", Buffer.from('{"source":"stale"}\n'));
  first.emit("exit", 0, null);
  second.stdout?.emit("data", Buffer.from('{"source":"current"}\n'));
  assert.deepEqual(messages, [{ source: "current" }]);
  assert.deepEqual(fatalReasons, []);
  assert.deepEqual(terminated, [first]);

  second.emit("exit", 1, null);
  assert.deepEqual(fatalReasons, ["Codex app-server exited."]);
  assert.deepEqual(lifecycleErrors, []);
  assert.equal(lifecycleLogs.filter((message) => message.includes("launched app-server child")).length, 2);
  assert.equal(lifecycleLogs.filter((message) => message.includes("exited")).length, 2);
  assert.equal(lifecycleLogs.some((message) => /\b(?:started|ready)\b/iu.test(message)), false);
});

test("asynchronous stop detaches ownership before process-tree termination settles", async () => {
  const first = fakeChild(201);
  const second = fakeChild(202);
  const children = [first, second];
  const releaseTermination = deferred();
  const terminated: ChildProcess[] = [];
  const server = new CodexAppServer({
    createChild: () => children.shift() ?? second,
    log: () => undefined,
    logError: () => undefined,
    onFatalExit: () => undefined,
    onMessage: () => undefined,
    projectRoot: "C:/workspace",
    terminateChildAsync: async (child) => {
      terminated.push(child);
      await releaseTermination.promise;
    },
  });

  server.send({ method: "first" });
  const stopping = server.stopAsync();
  let repeatedFinished = false;
  const repeated = server.stopAsync().then(() => { repeatedFinished = true; });
  try {
    await Promise.resolve();
    assert.equal(repeatedFinished, false);
    assert.throws(() => server.send({ method: "second" }), /retir/u);
    assert.deepEqual(terminated, [first]);
  } finally {
    releaseTermination.resolve();
    await Promise.all([stopping, repeated]);
  }
  server.send({ method: "second" });
  assert.equal(children.length, 0);
});

test("failed retirement fences replacement until an explicit stop retry succeeds", async () => {
  const children = [fakeChild(301), fakeChild(302)];
  let fails = true;
  let attempts = 0;
  const errors: string[] = [];
  const server = new CodexAppServer({
    createChild: () => children.shift()!,
    log: () => undefined,
    logError: (_name, message) => errors.push(message),
    onFatalExit: () => undefined,
    onMessage: () => undefined,
    projectRoot: "C:/workspace",
    terminateChildAsync: async () => {
      attempts += 1;
      if (fails) throw new Error("retirement denied");
    },
  });
  server.send({ method: "first" });
  await assert.rejects(server.stopAsync(), /retirement denied/u);
  assert.throws(() => server.send({ method: "second" }), /retir/u);
  assert.equal(children.length, 1);
  assert.equal(errors.length, 1);
  fails = false;
  await server.stopAsync();
  server.send({ method: "second" });
  assert.equal(attempts, 2);
  assert.equal(children.length, 0);
});

test("predecessor retirement closes every generation even when an older one fails", async () => {
  const oldest = new Error("oldest retirement failed");
  const previous = new Error("previous retirement failed");
  const server = new CodexAppServer({
    projectRoot: "C:/workspace", onFatalExit() {}, onMessage() {},
    previousAppServer: {
      retirePrevious: async () => { throw oldest; },
      stopAsync: async () => { throw previous; },
    } as unknown as CodexAppServer,
  });
  await assert.rejects(server.retirePrevious(), error => error instanceof AggregateError
    && error.errors.includes(oldest) && error.errors.includes(previous));
});

test("a new process owner cannot spawn until its retained predecessor retires", async () => {
  const release = deferred();
  let spawned = 0;
  const options = {
    createChild: () => fakeChild(++spawned),
    log() {}, logError() {}, onFatalExit() {}, onMessage() {},
    projectRoot: "C:/workspace",
    terminateChildAsync: async () => {},
  };
  const previous = new CodexAppServer({ ...options, terminateChildAsync: () => release.promise });
  previous.send({ method: "old" });
  const candidate = new CodexAppServer({ ...options, previousAppServer: previous });
  try {
    assert.throws(() => candidate.send({ method: "too early" }), /previous.*retir/i);
    assert.equal(spawned, 1);
    await candidate.stopAsync();
    previous.send({ method: "rollback still usable" });
    const retiring = candidate.retirePrevious();
    assert.throws(() => candidate.send({ method: "still too early" }), /previous.*retir/i);
    release.resolve();
    await retiring;
    candidate.send({ method: "new" });
    assert.equal(spawned, 2);
  } finally {
    release.resolve();
    await previous.stopAsync();
    await candidate.stopAsync();
  }
});

test("unexpected leader exit still retires its group before allowing replacement", async () => {
  const first = fakeChild(401);
  const children = [first, fakeChild(402)];
  const retired: ChildProcess[] = [];
  const server = new CodexAppServer({
    createChild: () => children.shift()!,
    log: () => undefined,
    logError: () => undefined,
    onFatalExit: () => undefined,
    onMessage: () => undefined,
    projectRoot: "C:/workspace",
    terminateChildAsync: async (child) => { retired.push(child); },
  });
  server.send({ method: "first" });
  first.emit("exit", 1, null);
  assert.throws(() => server.send({ method: "second" }), /retir/u);
  await server.stopAsync();
  assert.deepEqual(retired, [first]);
  server.send({ method: "second" });
  assert.equal(children.length, 0);
});
