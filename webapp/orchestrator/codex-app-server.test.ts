/*
 * No production exports. Node tests protect Codex native prompt suppression, asynchronous shutdown, and intentional child replacement from stale callbacks. Keywords: codex, app-server, policy, generation, test.
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
  ];

  for (const config of requiredConfigs) {
    const index = args.indexOf(config);
    assert.notEqual(index, -1, `missing ${config}`);
    assert.equal(args[index - 1], "--config");
  }
  assert.deepEqual(args.slice(-3), ["app-server", "--listen", "stdio://"]);
});

test("intentional replacement ignores stale child output and exit", () => {
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
    terminateChild: (child) => {
      terminated.push(child);
      (child as unknown as { killed: boolean }).killed = true;
    },
  });

  server.send({ method: "first" });
  server.stop();
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
  server.send({ method: "second" });
  assert.deepEqual(terminated, [first]);
  releaseTermination.resolve();
  await stopping;
});
