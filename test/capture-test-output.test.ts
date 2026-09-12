/*
 * No exports. Tests protect selective output capture, stream semantics and teardown.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { captureTestOutput } from "./capture-test-output.mts";

test("capture forwards unmatched bytes and preserves write completion", async context => {
  const stream = new PassThrough();
  const forwarded: Buffer[] = [];
  stream.on("data", chunk => forwarded.push(chunk));
  const records = captureTestOutput(context, stream, text => text === "expected");
  let callbacks = 0;
  assert.equal(stream.write("expected", () => { callbacks++; }), true);
  assert.equal(stream.write(Buffer.from("expected"), "utf8", () => { callbacks++; }), true);
  const bytes = Buffer.from([0, 255, 1]);
  stream.write(bytes);
  await new Promise<void>((resolve, reject) => stream.write("unexpected", error => error ? reject(error) : resolve()));
  assert.equal(callbacks, 2);
  assert.deepEqual(records, ["expected", "expected"]);
  assert.deepEqual(Buffer.concat(forwarded), Buffer.concat([bytes, Buffer.from("unexpected")]));
  const blocked: Pick<NodeJS.WritableStream, "write"> = { write: () => false };
  captureTestOutput(context, blocked, text => text === "expected");
  assert.equal(blocked.write("unexpected"), false);
  stream.destroy();
});

test("test teardown restores output even when its operation throws", async context => {
  const stream = new PassThrough();
  const forwarded: string[] = [];
  stream.on("data", chunk => forwarded.push(String(chunk)));
  const original = stream.write;
  await context.test("owned capture", child => {
    captureTestOutput(child, stream, text => text === "expected");
    assert.throws(() => {
      stream.write("expected");
      throw new Error("operation failed");
    }, /operation failed/);
  });
  assert.equal(stream.write, original);
  stream.write("expected");
  assert.deepEqual(forwarded, ["expected"]);
  stream.destroy();
});

test("capture handles worker output forwarded to the parent stream", async context => {
  const records = captureTestOutput(context, process.stdout, text => text === "worker sentinel\n");
  const worker = new Worker("process.stdout.write('worker sentinel\\n');", { eval: true });
  const [code] = await once(worker, "exit");
  assert.equal(code, 0);
  assert.deepEqual(records, ["worker sentinel\n"]);
});
