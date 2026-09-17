/* No exports. Protect native framing, failure retention and process disposal. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import VoiceRecognizerProcess from "./VoiceRecognizerProcess";
import type { VoiceEvent } from "workbench-shared/workbench/voice/voice-contract";

async function harness() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-process-test-"));
  const descriptor = path.join(directory, "runtime.json");
  await fs.writeFile(descriptor, JSON.stringify({
    version: 1, platform: process.platform, arch: process.arch,
    executable: process.execPath, modelDirectory: directory,
  }));
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  let spawned!: () => void;
  const launch = new Promise<void>(resolve => { spawned = resolve; });
  const events: VoiceEvent[] = [];
  const errors: Error[] = [];
  let terminated = false;
  const recognizer = new VoiceRecognizerProcess(descriptor, event => events.push(event), error => errors.push(error), {
    createChild: () => { spawned(); return child as unknown as ChildProcess; },
    terminateChild: async () => { terminated = true; },
  });
  return { process: recognizer, child, launch, events, errors, get terminated() { return terminated; },
    async dispose() { await recognizer.dispose(); await fs.rm(directory, { recursive: true, force: true }); } };
}

test("split UTF-8 lines retain native messages and commands wait for readiness", async () => {
  const h = await harness();
  try {
    let written = "";
    h.child.stdin.on("data", data => { written += String(data); });
    const sending = h.process.send({ type: "start", sessionId: "session" });
    await h.launch;
    assert.equal(written, "");
    h.child.stdout.write('{"type":"ready","version":1}\n');
    await sending;
    assert.deepEqual(JSON.parse(written), { type: "start", sessionId: "session" });
    const bytes = Buffer.from('{"type":"error","sessionId":"session","message":"caf\u00e9"}\n');
    const split = bytes.indexOf(0xc3) + 1;
    h.child.stdout.write(bytes.subarray(0, split));
    assert.deepEqual(h.events, []);
    h.child.stdout.write(bytes.subarray(split));
    assert.deepEqual(h.events, [{ type: "error", sessionId: "session", message: "caf\u00e9" }]);
  } finally { await h.dispose(); }
  assert.equal(h.terminated, true);
});

test("malformed native data retains one failure and cannot become ready later", async () => {
  const h = await harness();
  try {
    const preparing = h.process.prepare();
    const failed = assert.rejects(preparing, /Invalid native/);
    await h.launch;
    h.child.stdout.write("not-json\n");
    await failed;
    h.child.stdout.write('{"type":"ready","version":1}\n');
    await assert.rejects(h.process.prepare(), /Invalid native/);
    assert.equal(h.errors.length, 1);
  } finally { await h.dispose(); }
});

test("disposal releases pending readiness and fences late process callbacks", async () => {
  const h = await harness();
  const ready = h.process.prepare();
  const rejected = assert.rejects(ready, /disposed/);
  await h.launch;
  await h.dispose();
  await rejected;
  h.child.stdout.write('{"type":"started","sessionId":"late"}\n');
  h.child.emit("exit", 1);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.errors, []);
});
