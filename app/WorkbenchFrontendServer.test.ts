/*
 * No production exports. Node tests protect app-route delegation, SPA serving, legacy proxy semantics, bounded proxy failure, and lifecycle disposal.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchFrontendServer, { type WorkbenchFrontendBuildOwner } from "./WorkbenchFrontendServer.ts";

class FixtureCompiler implements WorkbenchFrontendBuildOwner {
  readonly events: string[] = [];

  constructor(readonly outputDirectoryPath: string) {}

  async startWatching() {
    this.events.push("start");
    return this.outputDirectoryPath;
  }

  async close() {
    this.events.push("close");
  }
}

async function staticFixture() {
  const outputDirectoryPath = await mkdtemp(path.join(os.tmpdir(), "workbench-frontend-server-"));
  await mkdir(path.join(outputDirectoryPath, "assets"));
  await writeFile(path.join(outputDirectoryPath, "index.html"), "<main>Standalone Workbench</main>", "utf8");
  await writeFile(path.join(outputDirectoryPath, "assets", "app.js"), "export {};", "utf8");
  return outputDirectoryPath;
}

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

test("serves the SPA and delegates launch restoration to app state routes", async (context) => {
  const compiler = new FixtureCompiler(await staticFixture());
  const server = new WorkbenchFrontendServer({
    compiler,
    hostname: "127.0.0.1",
    stateRoutes: {
      handle: async (_request, response, url) => {
        if (url.pathname !== "/launch") return false;
        response.writeHead(307, {
          "Cache-Control": "private, no-store",
          Location: "/project/nested%2Fproject%20one",
        });
        response.end();
        return true;
      },
    },
  });
  context.after(async () => await server.close());
  const { url } = await server.start();

  const page = await fetch(`${url}/project/one`, { headers: { Accept: "text/html" } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<main>Standalone Workbench</main>");

  const launch = await fetch(`${url}/launch`, { redirect: "manual" });
  assert.equal(launch.status, 307);
  assert.equal(launch.headers.get("location"), "/project/nested%2Fproject%20one");
  assert.equal(launch.headers.get("cache-control"), "private, no-store");
});

test("streams legacy methods, bodies, status, and response headers", async (context) => {
  const legacy = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(201, {
        "Content-Type": "application/json",
        "X-Request-Method": request.method ?? "",
      });
      response.write('{"body":');
      response.end(JSON.stringify(Buffer.concat(chunks).toString("utf8")) + "}");
    });
  });
  context.after(() => legacy.close());
  const legacyOrigin = await listen(legacy);

  const compiler = new FixtureCompiler(await staticFixture());
  const server = new WorkbenchFrontendServer({ compiler, hostname: "127.0.0.1", legacyOrigin });
  context.after(async () => await server.close());
  const { url } = await server.start();

  const response = await fetch(`${url}/api/echo`, {
    body: "sparkles",
    headers: { "Content-Type": "text/plain" },
    method: "POST",
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("x-request-method"), "POST");
  assert.deepEqual(await response.json(), { body: "sparkles" });
});

test("app-state routes bypass legacy Next while unrelated APIs still proxy", async (context) => {
  const legacyPaths: string[] = [];
  const legacy = createServer((request, response) => {
    legacyPaths.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("legacy");
  });
  context.after(() => legacy.close());
  const legacyOrigin = await listen(legacy);

  const compiler = new FixtureCompiler(await staticFixture());
  const server = new WorkbenchFrontendServer({
    compiler,
    hostname: "127.0.0.1",
    legacyOrigin,
    stateRoutes: {
      handle: async (_request, response, url) => {
        if (url.pathname !== "/api/workbench-client-state/global-preference") return false;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"owner":"app-state"}');
        return true;
      },
    },
  });
  context.after(async () => await server.close());
  const { url } = await server.start();

  const appStateResponse = await fetch(`${url}/api/workbench-client-state/global-preference`, { method: "PUT" });
  assert.deepEqual(await appStateResponse.json(), { owner: "app-state" });
  assert.deepEqual(legacyPaths, []);

  assert.equal(await (await fetch(`${url}/api/projects`)).text(), "legacy");
  assert.deepEqual(legacyPaths, ["/api/projects"]);
});

test("reports legacy failure and disposes compiler plus listener", async () => {
  const unavailable = createServer();
  const unavailableOrigin = await listen(unavailable);
  await new Promise<void>((resolve, reject) => unavailable.close((error) => error ? reject(error) : resolve()));

  const diagnostics: string[] = [];
  const compiler = new FixtureCompiler(await staticFixture());
  const server = new WorkbenchFrontendServer({
    compiler,
    hostname: "127.0.0.1",
    legacyOrigin: unavailableOrigin,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  const { url } = await server.start();

  const response = await fetch(`${url}/api/projects`);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /unavailable/u);
  assert.equal(diagnostics.length, 1);

  await server.close();
  assert.deepEqual(compiler.events, ["start", "close"]);
  await assert.rejects(fetch(url));
});
