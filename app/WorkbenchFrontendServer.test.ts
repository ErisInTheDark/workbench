/*
 * No production exports. Node tests protect stable listener delegation, free-port binding, and disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import WorkbenchFrontendServer from "./WorkbenchFrontendServer.ts";

test("keeps one bound port while delegating every request to the runtime owner", async (context) => {
  const paths: string[] = [];
  const server = new WorkbenchFrontendServer({
    hostname: "127.0.0.1",
    requests: {
      handleRequest: async (request, response) => {
        paths.push(request.url ?? "");
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("runtime");
      },
    },
  });
  context.after(async () => await server.close());
  const address = await server.start();
  assert.ok(address.port > 0);
  assert.equal(await (await fetch(`${address.url}/one`)).text(), "runtime");
  assert.equal(await (await fetch(`${address.url}/two`)).text(), "runtime");
  assert.deepEqual(paths, ["/one", "/two"]);
});

test("disposal releases the stable listener", async () => {
  const server = new WorkbenchFrontendServer({
    hostname: "127.0.0.1",
    requests: {
      handleRequest: async (_request, response) => { response.end(); },
    },
  });
  const { url } = await server.start();
  await server.close();
  await assert.rejects(fetch(url));
});
