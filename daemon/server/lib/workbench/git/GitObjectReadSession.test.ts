/* No production exports. Regression wards cover stream framing, concurrent readers and deterministic failure cleanup. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import GitObjectReadSession, { type GitObjectReadProcess } from "./GitObjectReadSession";

function processFixture(closeOnEnd = true) {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const commands: string[] = [];
  let closed = false;
  const close = (code: number | null = 0) => {
    if (closed) return;
    closed = true;
    events.emit("close", code);
  };
  const stdin = new Writable({
    write(chunk, _encoding, done) { commands.push(chunk.toString()); done(); },
    final(done) { done(); if (closeOnEnd) close(); },
  });
  const process = Object.assign(events, { stdin, stdout, stderr, kill: () => { close(null); return true; } });
  const reader = new GitObjectReadSession("fixture", () => process as unknown as GitObjectReadProcess);
  return { reader, commands, stdout, stdin, stderr, close, events, isClosed: () => closed };
}

function frame(id: string, type: string, body: Buffer) {
  return Buffer.concat([Buffer.from(`${id} ${type} ${body.length}\n`), body, Buffer.from("\n")]);
}

test("interleaved reads preserve split byte framing, missing objects and identity-only replies", async () => {
  const fixture = processFixture();
  const contents = Buffer.from("nul\0 and multibyte \u03bb\n");
  const blobId = "a".repeat(40);
  const commitId = "b".repeat(40);
  const first = fixture.reader.read(["refs/test/blob", "refs/test/missing"]);
  const second = fixture.reader.read(["refs/test/commit"], "info");
  const last = fixture.reader.read(["refs/test/last"]);
  const output = Buffer.concat([
    frame(blobId, "blob", contents),
    Buffer.from(`refs/test/missing missing\n${commitId} commit 999\n`),
    frame(blobId, "blob", Buffer.from("last\n")),
  ]);
  for (const byte of output) fixture.stdout.write(Buffer.from([byte]));
  assert.deepEqual(await first, [{ objectId: blobId, type: "blob", size: contents.length, contents }, null]);
  assert.deepEqual(await second, [{ objectId: commitId, type: "commit", size: 999, contents: null }]);
  assert.equal((await last)[0]?.contents?.toString(), "last\n");
  await fixture.reader.close();
  assert.equal(fixture.isClosed(), true);
  await assert.rejects(fixture.reader.read(["HEAD"]), /closed/u);
});

test("stream failures reject every waiting reader and complete disposal", async (context) => {
  context.mock.method(console, "warn", () => {});
  for (const failure of ["header", "terminator", "truncated", "process", "stdin", "exit"] as const) {
    const fixture = processFixture();
    const first = assert.rejects(fixture.reader.read(["one"]));
    const second = assert.rejects(fixture.reader.read(["two"]));
    if (failure === "header") fixture.stdout.write("not an object header\n");
    if (failure === "terminator") fixture.stdout.write(`${"a".repeat(40)} blob 4\ntext!`);
    if (failure === "truncated") {
      fixture.stdout.write(`${"a".repeat(40)} blob 4\ntext`);
      fixture.close();
    }
    if (failure === "process") fixture.events.emit("error", new Error("spawn failure"));
    if (failure === "stdin") fixture.stdin.emit("error", new Error("broken pipe"));
    if (failure === "exit") fixture.close(1);
    await Promise.all([first, second]);
    await assert.rejects(fixture.reader.close());
    assert.equal(fixture.isClosed(), true);
    await assert.rejects(fixture.reader.read(["later"]));
  }
});

test("invalid requests leave the stream usable and graceful close drains pending responses", async () => {
  const fixture = processFixture(false);
  await assert.rejects(fixture.reader.read(["HEAD\ncontents other"]), /valid Git object/u);
  assert.deepEqual(fixture.commands, []);
  const reply = fixture.reader.read(["empty"]);
  const closing = fixture.reader.close();
  fixture.stdout.write(frame("a".repeat(40), "blob", Buffer.alloc(0)));
  assert.equal((await reply)[0]?.contents?.length, 0);
  fixture.close();
  await closing;
  await fixture.reader.close();
  assert.equal(fixture.isClosed(), true);
});

test("stdin closure failures terminate the owned process", async (context) => {
  context.mock.method(console, "warn", () => {});
  const fixture = processFixture();
  context.mock.method(fixture.stdin, "end", () => { throw new Error("end failure"); });
  await assert.rejects(fixture.reader.close(), /end failure/u);
  assert.equal(fixture.isClosed(), true);
});

test("a stream accepts aggregate replies beyond a single command output limit", async () => {
  const fixture = processFixture();
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  for (let index = 0; index < 33; index += 1) {
    const result = fixture.reader.read([`object-${index}`]);
    fixture.stdout.write(frame("a".repeat(40), "blob", chunk));
    assert.deepEqual((await result)[0]?.contents, chunk);
  }
  await fixture.reader.close();
});
