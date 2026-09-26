/* No production exports. Protect lifetime streams and terminal shutdown admission. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import WorkbenchAppLifetime from "./WorkbenchAppLifetime";

test("app lifetime retains streams until shutdown and rejects late consumers", () => {
  const owner = new WorkbenchAppLifetime();
  const responses: { status: number; ended: boolean }[] = [];
  const attach = (method: string) => {
    const state = { status: 0, ended: false };
    responses.push(state);
    const response = Object.assign(new EventEmitter(), {
      writeHead(status: number) { state.status = status; },
      write() {},
      end() { state.ended = true; },
    });
    owner.handle({ method } as IncomingMessage, response as unknown as ServerResponse);
    return state;
  };
  const stream = attach("GET");
  const probe = attach("HEAD");
  assert.equal(stream.ended, false);
  assert.equal(probe.ended, true);
  owner.close();
  assert.equal(stream.ended, true);
  assert.equal(attach("GET").status, 503);
});

test("app lifetime socket stays ready until process shutdown, then signals stop", async context => {
  const owner = new WorkbenchAppLifetime();
  const server = createServer((request, response) => owner.handle(request, response));
  server.on("upgrade", (request, socket, head) => owner.handleUpgrade(request, socket, head));
  context.after(async () => {
    owner.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const probe = await fetch(`${origin}/api/workbench-app-lifetime?capabilities=2`, { method: "HEAD" });
  assert.equal(probe.headers.get("x-workbench-app-lifetime-socket"), "1");
  const client = new WebSocket(`${origin.replace(/^http/u, "ws")}/api/workbench-app-lifetime/socket`, { origin });
  context.after(() => client.terminate());
  const [ready] = await once(client, "message");
  assert.deepEqual(JSON.parse(ready.toString()), { kind: "ready" });
  const stopped = once(client, "message");
  const closed = once(client, "close");
  owner.close();
  const [message] = await stopped;
  assert.deepEqual(JSON.parse(message.toString()), { kind: "stopped" });
  await closed;
});
