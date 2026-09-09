/*
 * No production exports. Tests protect free-port binding, request delegation, and listener disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Socket } from "node:net";

import HttpServer from "./HttpServer.ts";

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
