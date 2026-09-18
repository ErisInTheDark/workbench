/* No production exports. Protect bounded local endpoint publication and instance-owned cleanup. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readDaemonEndpoint, publishDaemonEndpoint, removeDaemonEndpoint,
} from "./workbench-daemon-endpoint.ts";

const first = { version: 1 as const, instanceId: "6e1a6f64-af71-4639-b997-65d8f314b352", pid: process.pid, origin: "http://127.0.0.1:32123" };

test("publication is readable and an old process cannot withdraw its replacement", async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wb-daemon-endpoint-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "runtime.json");
  assert.equal(await readDaemonEndpoint(file), null);
  await publishDaemonEndpoint(file, first);
  assert.deepEqual(await readDaemonEndpoint(file), first);
  const replacement = { ...first, instanceId: "8a87278e-9726-433b-aad8-a0a0372cf066", origin: "http://127.0.0.1:32124" };
  await publishDaemonEndpoint(file, replacement);
  await removeDaemonEndpoint(file, first.instanceId);
  assert.deepEqual(await readDaemonEndpoint(file), replacement);
  await removeDaemonEndpoint(file, replacement.instanceId);
  assert.equal(await readDaemonEndpoint(file), null);
});

test("untrusted and oversized records never become a daemon address", async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wb-daemon-endpoint-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "runtime.json");
  for (const origin of ["http://192.168.1.2:32123", "http://127.0.0.1:32123/other", "https://127.0.0.1:32123"]) {
    await fs.writeFile(file, JSON.stringify({ ...first, origin }));
    await assert.rejects(readDaemonEndpoint(file));
  }
  await fs.writeFile(file, " ".repeat(16_385));
  await assert.rejects(readDaemonEndpoint(file));
});
