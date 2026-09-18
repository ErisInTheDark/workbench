/* No production exports. Protect bound-address publication, singleton ownership and listener disposal. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchDaemonListener from "./WorkbenchDaemonListener.ts";
import { readDaemonEndpoint } from "../../shared/process/workbench-daemon-endpoint.ts";

test("binds an assigned loopback port and publishes only when the runtime is ready", async context => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wb-daemon-listener-"));
  const endpointPath = path.join(directory, "runtime.json");
  const leasePath = path.join(directory, "launch.sqlite3");
  const owner = new WorkbenchDaemonListener({ endpointPath, leasePath });
  const duplicate = new WorkbenchDaemonListener({ endpointPath, leasePath });
  context.after(async () => {
    await duplicate.close();
    await owner.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const server = http.createServer((_request, response) => response.end("ready"));
  const endpoint = await owner.bind(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  assert.ok(address.port > 0);
  assert.equal(new URL(endpoint.origin).port, String(address.port));
  assert.equal(await readDaemonEndpoint(endpointPath), null);
  await assert.rejects(duplicate.bind(http.createServer()), /already running/u);
  await owner.publish();
  assert.deepEqual(await readDaemonEndpoint(endpointPath), endpoint);
  assert.equal(await (await fetch(endpoint.origin)).text(), "ready");
  await owner.close();
  assert.equal(await readDaemonEndpoint(endpointPath), null);
  assert.equal(server.listening, false);
});
