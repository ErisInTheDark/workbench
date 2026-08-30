/*
 * No production exports. Tests protect free-port binding, request delegation, and listener disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import HttpServer from "./HttpServer.ts";

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
