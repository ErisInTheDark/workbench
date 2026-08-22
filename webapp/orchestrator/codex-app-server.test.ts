/*
 * No production exports. Node tests protect Codex launch policy and intentional child replacement from stale callbacks. Keywords: codex, app-server, args, generation, test.
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

test("managed Codex disables native subagents without process-scoped MCP config", () => {
  assert.deepEqual(getCodexAppServerArgs(), [
    "--config",
    "features.multi_agent=false",
    "app-server",
    "--listen",
    "stdio://",
  ]);
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
  assert.deepEqual(lifecycleLogs, [
    "[codex-bridge] started shared stdio app-server",
    "[codex-bridge] started shared stdio app-server",
    "[codex-stdio] exited (code=0, signal=null)",
    "[codex-stdio] exited (code=1, signal=null)",
  ]);
});
