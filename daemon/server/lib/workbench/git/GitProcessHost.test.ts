/*
 * No exports. Protect the git process host: bounded concurrency, execFile-compatible failures, abort kills, streaming
 * relays, worker loss, a real worker round trip, and real commands finishing while another process holds their pipes.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { SHARE_ENV, Worker } from "node:worker_threads";
import GitProcessHost, { GitProcessError, type GitProcessWorkerEvent, type GitProcessWorkerRequest } from "./GitProcessHost";

class FakeWorker extends EventEmitter {
  readonly requests: GitProcessWorkerRequest[] = [];
  terminated = false;
  postMessage(request: GitProcessWorkerRequest) { this.requests.push(request); }
  unref() {}
  async terminate() { this.terminated = true; return 0; }
  reply(event: GitProcessWorkerEvent) { this.emit("message", event); }
  runs() { return this.requests.filter((request): request is Extract<GitProcessWorkerRequest, { kind: "run" }> => request.kind === "run"); }
}

function host(concurrency = 2) {
  const worker = new FakeWorker();
  return { worker, host: new GitProcessHost({ concurrency, createWorker: () => worker as unknown as Worker }) };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const ok = (id: number, text = "") => ({
  kind: "result" as const, id, code: 0, signal: null, overflow: false, stdout: new TextEncoder().encode(text), stderr: "",
});

test("commands beyond the concurrency bound wait for a slot", async () => {
  const { worker, host: git } = host(2);
  const results = [1, 2, 3].map(index => git.runText({ args: ["status", String(index)], cwd: "." }));
  await flush();
  assert.equal(worker.runs().length, 2);
  worker.reply(ok(worker.runs()[0]!.id, "first"));
  assert.equal(await results[0], "first");
  await flush();
  assert.equal(worker.runs().length, 3);
  for (const run of worker.runs().slice(1)) worker.reply(ok(run.id));
  await Promise.all(results);
});

test("unsuccessful exits reject with execFile-shaped details", async () => {
  const { worker, host: git } = host();
  const result = git.run({ args: ["config", "--get", "x"], cwd: "." });
  await flush();
  worker.reply({ ...ok(worker.runs()[0]!.id, "partial"), code: 1, stderr: "nope" });
  const error = await result.then(() => null, (failure: unknown) => failure);
  assert.ok(error instanceof GitProcessError);
  assert.equal(error.code, 1);
  assert.equal(error.stderr, "nope");
  assert.equal(error.stdout, "partial");
});

test("aborting a running command kills it and rejects", async () => {
  const { worker, host: git } = host();
  const controller = new AbortController();
  const result = git.run({ args: ["log"], cwd: ".", signal: controller.signal });
  await flush();
  const { id } = worker.runs()[0]!;
  controller.abort();
  assert.ok(worker.requests.some(request => request.kind === "kill" && request.id === id));
  worker.reply({ ...ok(id), code: null, signal: "SIGTERM" });
  await assert.rejects(result);
});

test("streams relay data and close, and a lost worker fails what it was running", async () => {
  const { worker, host: git } = host();
  const child = git.open({ args: ["cat-file", "--batch-command"], cwd: "." });
  const open = worker.requests.find(request => request.kind === "open")!;
  const received: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => received.push(chunk.toString()));
  child.stdin.write("info HEAD\n");
  await flush();
  assert.ok(worker.requests.some(request => request.kind === "write"));
  worker.reply({ kind: "stdout", id: open.id, data: new TextEncoder().encode("abc commit 1\n") });
  await flush();
  assert.deepEqual(received, ["abc commit 1\n"]);

  const closed = new Promise<unknown>(resolve => child.once("close", resolve));
  const pending = git.run({ args: ["status"], cwd: "." });
  await flush();
  const errors: unknown[] = [];
  child.once("error", error => errors.push(error));
  const logged = console.error;
  console.error = () => {};
  try {
    worker.emit("exit", 1);
  } finally { console.error = logged; }
  await closed;
  assert.equal(errors.length, 1);
  await assert.rejects(pending, GitProcessError);
});

test("a real worker runs git and streams cat-file", async () => {
  const git = new GitProcessHost();
  try {
    assert.match(await git.runText({ args: ["--version"], cwd: process.cwd() }), /^git version /u);
    const child = git.open({ args: ["cat-file", "--batch-command"], cwd: process.cwd() });
    const output = new Promise<string>(resolve => child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString())));
    child.stdin.write("info HEAD\n");
    assert.match(await output, /^[0-9a-f]+ commit \d+\n/u);
    const closed = new Promise(resolve => child.once("close", resolve));
    child.stdin.end();
    await closed;
  } finally {
    await git.dispose();
  }
});

test("commands finish from their exit when another process keeps their output pipe open", { timeout: 20_000 }, async () => {
  // A backgrounded sleep inherits stdout like a handle leaked into a concurrently spawned process; it prints its pid.
  const hold = ["-c", "alias.hold=!sleep 600 & p=$!; cat /proc/$p/winpid 2>/dev/null || echo $p", "hold"];
  const holders: number[] = [];
  const git = new GitProcessHost({
    createWorker: () => {
      const worker = new Worker(new URL("./git-process-worker-bootstrap.mjs", import.meta.url), { env: SHARE_ENV, stderr: true });
      worker.stderr.resume();
      return worker;
    },
  });
  try {
    holders.push(Number((await git.runText({ args: hold, cwd: process.cwd() })).trim()));
    const child = git.open({ args: hold, cwd: process.cwd() });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const code = await new Promise(resolve => child.once("close", resolve));
    holders.push(Number(output.trim()));
    assert.equal(code, 0);
  } finally {
    for (const pid of holders) if (pid > 0) try { process.kill(pid); } catch { /* already gone */ }
    await git.dispose();
  }
});
