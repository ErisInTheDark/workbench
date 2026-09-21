/*
 * No production exports. Tests protect free-port binding, request delegation, and listener disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Socket } from "node:net";
import { connect } from "node:net";
import { once } from "node:events";

import HttpServer from "./HttpServer.ts";

test("listener disposal retires upgraded connections", async context => {
  let upgraded!: () => void;
  const upgrade = new Promise<void>(resolve => { upgraded = resolve; });
  const server = new HttpServer({
    hostname: "127.0.0.1", handleRequest: (_request, response) => { response.end(); },
    handleUpgrade: (_request, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n");
      upgraded();
    },
  });
  context.after(() => server.close({ force: true }));
  const address = await server.start();
  const client = connect(address.port, "127.0.0.1");
  context.after(() => client.destroy());
  client.resume();
  await once(client, "connect");
  client.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n");
  await upgrade;
  const closed = once(client, "close");
  await server.close();
  await closed;
});

test("force close reaches connections on a listener already draining gracefully", async () => {
  let enter!: () => void;
  let socket!: Socket;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const server = new HttpServer({
    hostname: "127.0.0.1",
    handleRequest: (request) => { socket = request.socket; enter(); },
  });
  const address = await server.start();
  const request = fetch(address.url).then(() => null, error => error);
  await entered;
  const graceful = server.close();
  const forced = server.close({ force: true });
  try {
    assert.equal(socket.destroyed, true, "The closing listener must retain its active sockets");
  } finally {
    socket.destroy();
    await Promise.all([graceful, forced, request]);
  }
});

test("delegates through one OS-assigned listener until disposal", async (context) => {
  const server = new HttpServer({
    handleRequest: (_request, response) => { response.end("ok"); },
    hostname: "127.0.0.1",
  });
  context.after(async () => await server.close());
  const address = await server.start();
  assert.ok(address.port > 0);
  assert.equal(await (await fetch(address.url)).text(), "ok");
});
