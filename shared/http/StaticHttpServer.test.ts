/*
 * No production exports. Node tests protect static serving, compression, revalidation, SPA fallback, path confinement, request seams, free-port binding, and disposal.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory.ts";
import StaticHttpServer from "./StaticHttpServer.ts";

async function fixture() {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-static-server-");
  const rootDirectoryPath = temporary.path;
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

test("uses the SPA fallback for HTML navigation, including routes ending in a file extension, but not asset requests", async (context) => {
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

  const fileRoute = await fetch(`${url}/project/@/file/icons/a.svg`, { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  assert.equal(fileRoute.status, 200);
  assert.equal(await fileRoute.text(), "<main>Workbench</main>");
  assert.equal((await fetch(`${url}/missing.js`)).status, 404);
  assert.equal((await fetch(`${url}/missing.js`, { headers: { Accept: "*/*" } })).status, 404);
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

function bytesRequest(url: string, requestPath: string, headers: Record<string, string>, method = "GET") {
  const origin = new URL(url);
  return new Promise<{ body: Buffer; headers: http.IncomingHttpHeaders; statusCode: number | undefined }>((resolve, reject) => {
    // No keep-alive agent, so server disposal does not wait on idle sockets.
    const request = http.request({ agent: false, headers, hostname: origin.hostname, method, path: requestPath, port: Number(origin.port) }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ body: Buffer.concat(chunks), headers: response.headers, statusCode: response.statusCode }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("compresses large text assets per accepted encoding and revalidates unchanged files", async (context) => {
  const rootDirectoryPath = await fixture();
  const bundle = `export const words = ${JSON.stringify(Array.from({ length: 400 }, (_, index) => `word-${index}`))};\n`;
  await writeFile(path.join(rootDirectoryPath, "assets", "bundle.js"), bundle, "utf8");
  const server = new StaticHttpServer({ cacheSeconds: 0, hostname: "127.0.0.1", rootDirectoryPath });
  context.after(async () => await server.close());
  const { url } = await server.start();

  const decoders = { br: brotliDecompressSync, gzip: gunzipSync } as const;
  for (const encoding of ["br", "gzip"] as const) {
    const response = await bytesRequest(url, "/assets/bundle.js", { "Accept-Encoding": encoding });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-encoding"], encoding);
    assert.ok(response.body.length < Buffer.byteLength(bundle));
    assert.equal(decoders[encoding](response.body).toString("utf8"), bundle);
    assert.equal(response.headers["cache-control"], "no-cache");

    const revalidated = await bytesRequest(url, "/assets/bundle.js", {
      "Accept-Encoding": encoding,
      "If-None-Match": String(response.headers.etag),
    });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.body.length, 0);
  }

  const identity = await bytesRequest(url, "/assets/bundle.js", { "Accept-Encoding": "identity" });
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.equal(identity.body.toString("utf8"), bundle);

  const head = await bytesRequest(url, "/assets/bundle.js", { "Accept-Encoding": "gzip" }, "HEAD");
  const get = await bytesRequest(url, "/assets/bundle.js", { "Accept-Encoding": "gzip" });
  assert.equal(head.headers["content-length"], get.headers["content-length"]);

  await writeFile(path.join(rootDirectoryPath, "assets", "bundle.js"), `${bundle}// changed\n`, "utf8");
  const changed = await bytesRequest(url, "/assets/bundle.js", { "If-None-Match": String(identity.headers.etag) });
  assert.equal(changed.statusCode, 200);
  assert.match(changed.body.toString("utf8"), /changed/u);
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
