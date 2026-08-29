/*
 * No production exports. Node tests protect launch restoration, SPA serving, legacy proxy semantics, bounded proxy failure, and lifecycle disposal.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WorkbenchFrontendServer, { type WorkbenchFrontendBuildOwner } from "./WorkbenchFrontendServer.ts";

const require = createRequire(import.meta.url);
const { createLastProjectLaunchCookie } = require("../webapp/lib/workbench/state/last-project-cookie.ts") as typeof import("../webapp/lib/workbench/state/last-project-cookie.ts");

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

test("serves the SPA and preserves last-project launch restoration", async (context) => {
  const compiler = new FixtureCompiler(await staticFixture());
  const server = new WorkbenchFrontendServer({ compiler, hostname: "127.0.0.1" });
  context.after(async () => await server.close());
  const { url } = await server.start();

  const page = await fetch(`${url}/project/one`, { headers: { Accept: "text/html" } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<main>Standalone Workbench</main>");

  const launch = await fetch(`${url}/launch`, {
    headers: { Cookie: createLastProjectLaunchCookie("nested/project one").split(";", 1)[0] },
    redirect: "manual",
  });
  assert.equal(launch.status, 307);
  assert.equal(launch.headers.get("location"), "/nested/project%20one");
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
