/*
 * No production exports. Node tests protect static serving, SPA fallback, path confinement, request seams, free-port binding, and disposal.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import StaticHttpServer from "./StaticHttpServer.ts";

async function fixture() {
  const rootDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-static-server-"));
  await mkdir(path.join(rootDirectoryPath, "assets"));
  await writeFile(path.join(rootDirectoryPath, "index.html"), "<main>Workbench</main>", "utf8");
  await writeFile(path.join(rootDirectoryPath, "assets", "app.js"), "console.log('ready');", "utf8");
  return rootDirectoryPath;
}

function rawRequest(url: string, requestPath: string) {
  const origin = new URL(url);
  return new Promise<{ body: string; statusCode: number | undefined }>((resolve, reject) => {
    const request = http.request({
      hostname: origin.hostname,
      method: "GET",
      path: requestPath,
      port: Number(origin.port),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        statusCode: response.statusCode,
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("serves static files and HEAD responses from an OS-assigned port", async (context) => {
  const server = new StaticHttpServer({
    hostname: "127.0.0.1",
    rootDirectoryPath: await fixture(),
  });
  context.after(async () => await server.close());
  const address = await server.start();

  assert.ok(address.port > 0);
  const getResponse = await fetch(`${address.url}/assets/app.js`);
  assert.equal(getResponse.status, 200);
  assert.equal(await getResponse.text(), "console.log('ready');");
  assert.match(getResponse.headers.get("content-type") ?? "", /javascript/u);

  const headResponse = await fetch(`${address.url}/assets/app.js`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), "");
  assert.equal(headResponse.headers.get("content-length"), getResponse.headers.get("content-length"));
});

test("uses the SPA fallback only for extensionless HTML navigation", async (context) => {
  const server = new StaticHttpServer({
    hostname: "127.0.0.1",
    rootDirectoryPath: await fixture(),
    spaFallbackPath: "index.html",
  });
  context.after(async () => await server.close());
  const { url } = await server.start();

  const navigation = await fetch(`${url}/project/one`, { headers: { Accept: "text/html" } });
  assert.equal(navigation.status, 200);
  assert.equal(await navigation.text(), "<main>Workbench</main>");

  assert.equal((await fetch(`${url}/missing.js`)).status, 404);
  assert.equal((await fetch(`${url}/missing`, { headers: { Accept: "application/json" } })).status, 404);
});

test("rejects decoded traversal before reading outside the static root", async (context) => {
  const server = new StaticHttpServer({
    hostname: "127.0.0.1",
    rootDirectoryPath: await fixture(),
  });
  context.after(async () => await server.close());
  const { url } = await server.start();

  const response = await rawRequest(url, "/%2e%2e%2foutside.txt");
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /escapes/u);
});

test("runs the first-party request seam before static method handling", async (context) => {
  const server = new StaticHttpServer({
    beforeStaticRequest: ({ response, url }) => {
      if (url.pathname !== "/readyz") return false;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ready":true}');
      return true;
    },
    hostname: "127.0.0.1",
    rootDirectoryPath: await fixture(),
  });
  context.after(async () => await server.close());
  const { url } = await server.start();

  const response = await fetch(`${url}/readyz`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true });
});

test("disposal releases the listener", async () => {
  const server = new StaticHttpServer({
    hostname: "127.0.0.1",
    rootDirectoryPath: await fixture(),
  });
  const { url } = await server.start();
  await server.close();

  await assert.rejects(fetch(url));
});
