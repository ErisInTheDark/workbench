/*
 * No production exports. Node tests protect stable listener delegation, free-port binding, and disposal.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
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

test("rejects an occupied target without retiring the current listener", async (context) => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => blocker.close());
  const blockerAddress = blocker.address();
  assert.ok(blockerAddress && typeof blockerAddress !== "string");
  const commits: string[] = [];
  const server = new WorkbenchFrontendServer({
    hostname: "127.0.0.1",
    requests: {
      handleRequest: async (_request, response) => { response.end("current"); },
    },
  });
  context.after(async () => await server.close());
  const current = await server.start();

  await assert.rejects(
    server.moveToPort(blockerAddress.port, async () => { commits.push("commit"); }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EADDRINUSE",
  );
  assert.deepEqual(commits, []);
  assert.equal(await (await fetch(current.url)).text(), "current");
});

test("serves a replacement before draining an active request on the old listener", async (context) => {
  let releaseHeldRequest = () => {};
  const heldRequest = new Promise<void>((resolve) => {
    releaseHeldRequest = resolve;
  });
  let markHeldRequestStarted = () => {};
  const heldRequestStarted = new Promise<void>((resolve) => {
    markHeldRequestStarted = resolve;
  });
  const server = new WorkbenchFrontendServer({
    hostname: "127.0.0.1",
    requests: {
      handleRequest: async (request, response) => {
        if (request.url === "/hold") {
          markHeldRequestStarted();
          await heldRequest;
        }
        response.end("runtime");
      },
    },
  });
  context.after(async () => await server.close());
  const current = await server.start();
  const oldRequest = fetch(`${current.url}/hold`);
  await heldRequestStarted;
  const replacement = await server.moveToPort(0, async () => {});

  assert.notEqual(replacement.port, current.port);
  assert.equal(await (await fetch(replacement.url)).text(), "runtime");
  releaseHeldRequest();
  assert.equal(await (await oldRequest).text(), "runtime");
  await assert.rejects(fetch(current.url));
});

test("persists the current random port without rebinding it", async (context) => {
  const server = new WorkbenchFrontendServer({
    hostname: "127.0.0.1",
    requests: {
      handleRequest: async (_request, response) => { response.end(); },
    },
  });
  context.after(async () => await server.close());
  const current = await server.start();
  let persisted = 0;
  const unchanged = await server.moveToPort(current.port, async () => {
    persisted = current.port;
  });
  assert.deepEqual(unchanged, current);
  assert.equal(persisted, current.port);
});
