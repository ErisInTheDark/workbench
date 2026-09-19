/* No exports. Exercises native transport ordering, cancellation isolation and executor retirement. */
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";
import CodexExecServer from "./CodexExecServer";
import type { CodexExecRequest } from "./codex-exec-protocol";

function fixture(autoInitialize = true) {
  const calls: { id: number; method: string; params: { processId: string } }[] = [];
  const waiting: (() => void)[] = [];
  const child = Object.assign(new ChildProcess(), {
    pid: 123, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const call = JSON.parse(chunk.toString());
      calls.push(call);
      if (call.method === "initialize" && autoInitialize) reply(call.id, { sessionId: "test" });
      for (const wake of waiting.splice(0)) wake();
      callback();
    } }),
  }) as ChildProcessWithoutNullStreams;
  function send(message: object) { child.stdout.push(`${JSON.stringify(message)}\n`); }
  function reply(id: number, result: object) { send({ jsonrpc: "2.0", id, result }); }
  function reject(id: number) { send({ jsonrpc: "2.0", id, error: { code: -32602, message: "command rejected" } }); }
  async function next(method: string, index = 0) {
    while (!calls.filter(call => call.method === method)[index]) {
      await new Promise<void>(resolve => waiting.push(resolve));
    }
    return calls.filter(call => call.method === method)[index]!;
  }
  function event(method: string, processId: string, data: object = {}) {
    send({ method, params: { processId, seq: 1, ...data } });
  }
  function finish(processId: string, text: string) {
    event("process/output", processId, { stream: "stdout", chunk: Buffer.from(text).toString("base64") });
    event("process/exited", processId, { exitCode: 0 });
    event("process/closed", processId);
  }
  let retired = 0;
  const errors: string[] = [];
  const owner = new CodexExecServer({
    cwd: process.cwd(), spawnProcess: () => child,
    retireProcess: async () => { retired++; child.emit("close", 0); },
    reportError: message => errors.push(message),
  });
  const request: CodexExecRequest = {
    command: ["test"], cwd: process.cwd(), permissions: { type: "disabled" },
    workspaceRoots: [process.cwd()], windowsSandboxLevel: "elevated", windowsSandboxPrivateDesktop: true,
  };
  return { owner, child, next, reply, reject, event, finish, request, errors, retired: () => retired };
}

test("concurrent commands retain interleaved output through exit until streams close", async t => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const first = f.owner.execute(f.request, new AbortController().signal);
  const second = f.owner.execute(f.request, new AbortController().signal);
  const a = await f.next("process/start");
  const b = await f.next("process/start", 1);
  f.reply(a.id, { processId: a.params.processId });
  f.reply(b.id, { processId: b.params.processId });
  f.event("process/output", a.params.processId, { stream: "stdout", chunk: Buffer.from("a").toString("base64") });
  f.finish(b.params.processId, "second");
  f.event("process/exited", a.params.processId, { exitCode: 7 });
  f.event("process/output", a.params.processId, { stream: "stderr", chunk: Buffer.from("late").toString("base64") });
  f.event("process/closed", a.params.processId);
  assert.deepEqual(await first, { exitCode: 7, stdout: "a", stderr: "late" });
  assert.equal((await second).stdout, "second");
});

test("cancellation during start terminates only that command after admission", async t => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const cancel = new AbortController();
  const first = f.owner.execute(f.request, cancel.signal);
  const rejected = assert.rejects(first, /cancelled/);
  const second = f.owner.execute(f.request, new AbortController().signal);
  const a = await f.next("process/start");
  const b = await f.next("process/start", 1);
  cancel.abort(new Error("cancelled"));
  f.reply(a.id, { processId: a.params.processId });
  f.reply(b.id, { processId: b.params.processId });
  const terminate = await f.next("process/terminate");
  assert.equal(terminate.params.processId, a.params.processId);
  f.reply(terminate.id, { running: false });
  f.finish(a.params.processId, "");
  f.finish(b.params.processId, "unaffected");
  await rejected;
  assert.equal((await second).stdout, "unaffected");
});

test("transport loss rejects active commands and does not replay them", async () => {
  const f = fixture();
  const command = f.owner.execute(f.request, new AbortController().signal);
  const rejected = assert.rejects(command, /connection closed/);
  await f.next("process/start");
  f.child.emit("close", 1);
  await rejected;
  await f.owner.dispose();
  await assert.rejects(f.owner.execute(f.request, new AbortController().signal), /disposed/);
  assert.ok(f.errors.some(message => message.includes("not replayed")));
});

test("explicit disposal retires starting commands and waits for the owned tree", async () => {
  const f = fixture();
  const command = f.owner.execute(f.request, new AbortController().signal);
  const rejected = assert.rejects(command, /retiring|connection closed/);
  await f.next("process/start");
  await f.owner.dispose();
  await rejected;
  assert.equal(f.retired(), 1);
});

test("one rejected start does not poison the executor or another command", async t => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const first = f.owner.execute(f.request, new AbortController().signal);
  const failed = assert.rejects(first, /command rejected/);
  const start = await f.next("process/start");
  f.reject(start.id);
  await failed;
  const next = f.owner.execute(f.request, new AbortController().signal);
  const second = await f.next("process/start", 1);
  f.reply(second.id, { processId: second.params.processId });
  f.finish(second.params.processId, "healthy");
  assert.equal((await next).stdout, "healthy");
});

test("output beyond the capture limit is drained so the command can still settle", async t => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const execution = f.owner.execute(f.request, new AbortController().signal);
  const start = await f.next("process/start");
  f.reply(start.id, { processId: start.params.processId });
  const chunk = Buffer.alloc(1024 * 1024, "x").toString("base64");
  for (let index = 0; index < 3; index++) f.event("process/output", start.params.processId, { stream: "stdout", chunk });
  f.finish(start.params.processId, "tail");
  const result = await execution;
  assert.equal(result.exitCode, 0);
  assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
  assert.match(result.stderr, /truncated/);
});

test("executor drain cancels owned commands but leaves the process usable if replacement rolls back", async t => {
  const f = fixture();
  t.after(() => f.owner.dispose());
  const running = f.owner.execute(f.request, new AbortController().signal);
  const cancelled = assert.rejects(running, /replacement/);
  const start = await f.next("process/start");
  f.reply(start.id, { processId: start.params.processId });
  const drained = f.owner.cancelAll(new Error("replacement"));
  const terminate = await f.next("process/terminate");
  f.reply(terminate.id, { running: false });
  f.finish(start.params.processId, "");
  await drained;
  await cancelled;
  f.owner.resume();
  const after = f.owner.execute(f.request, new AbortController().signal);
  const next = await f.next("process/start", 1);
  f.reply(next.id, { processId: next.params.processId });
  f.finish(next.params.processId, "rollback");
  assert.equal((await after).stdout, "rollback");
});

test("drain cancels readiness waiters and prevents late command admission", async t => {
  const f = fixture(false);
  t.after(() => f.owner.dispose());
  const running = f.owner.execute(f.request, new AbortController().signal);
  const cancelled = assert.rejects(running, /replacement/);
  const initialize = await f.next("initialize");
  await f.owner.cancelAll(new Error("replacement"));
  await cancelled;
  f.reply(initialize.id, { sessionId: "test" });
  await assert.rejects(f.owner.execute(f.request, new AbortController().signal), /replacement/);
  f.owner.resume();
  const next = f.owner.execute(f.request, new AbortController().signal);
  const start = await f.next("process/start");
  f.reply(start.id, { processId: start.params.processId });
  f.finish(start.params.processId, "new admission");
  assert.equal((await next).stdout, "new admission");
});
