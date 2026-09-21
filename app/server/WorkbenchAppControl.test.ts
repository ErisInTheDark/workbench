/*
 * No production exports. Protect private app control, port movement and the existing Quit owner.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import WorkbenchAppControl from "./WorkbenchAppControl.ts";
import { readServiceEndpoint } from "../../shared/process/workbench-service-endpoint.ts";

test("app control authenticates, follows port movement and routes Quit once", async context => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-app-control-"));
  const endpointPath = path.join(root, "runtime.json");
  let quitCount = 0;
  let quit!: () => void;
  const quitted = new Promise<void>(resolve => { quit = resolve; });
  const control = new WorkbenchAppControl({
    root, endpointPath, quit: () => { quitCount++; quit(); },
    warn: message => assert.fail(message),
  });
  const servers: http.Server[] = [];
  const listen = async () => {
    const server = http.createServer((request, response) => {
      if (!control.handle(request, response)) { response.writeHead(404); response.end(); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  context.after(async () => {
    await control.close();
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    await fs.rm(root, { recursive: true, force: true });
  });
  const firstOrigin = await listen();
  await control.publish(firstOrigin);
  const first = await readServiceEndpoint(endpointPath);
  assert.ok(first);
  const headers = { Authorization: `Bearer ${first.token}` };
  assert.equal((await fetch(`${firstOrigin}/_workbench-control/process`)).status, 403);
  assert.equal((await fetch(`${firstOrigin}/_workbench-control/process`, {
    headers: { ...headers, "x-workbench-network-device": "remote" },
  })).status, 403);
  const nextOrigin = await listen();
  await control.publish(nextOrigin);
  const next = await readServiceEndpoint(endpointPath);
  assert.equal(next?.instanceId, first.instanceId);
  assert.equal(next?.origin, nextOrigin);
  const health = await fetch(`${nextOrigin}/_workbench-control/health`, { headers });
  const identity = await health.json() as { origin: string; token?: string };
  assert.equal(identity.origin, nextOrigin);
  assert.equal(identity.token, undefined);
  const wrong = await fetch(`${nextOrigin}/_workbench-control/quit/00000000-0000-4000-8000-000000000000`, { method: "POST", headers });
  assert.equal(wrong.status, 404);
  assert.equal(quitCount, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response: Response = await fetch(`${nextOrigin}/_workbench-control/quit/${first.instanceId}`, { method: "POST", headers });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  }
  await quitted;
  assert.equal(quitCount, 1);
});
