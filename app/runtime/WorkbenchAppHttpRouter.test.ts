/*
 * No production exports. Tests protect client-log admission, SPA serving, launch restoration, and legacy proxy ownership.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import HttpServer from "workbench-shared/http/HttpServer";

import WorkbenchAppLogger from "../WorkbenchAppLogger.ts";
import type WorkbenchAppStateController from "../state/WorkbenchAppStateController.ts";
import WorkbenchAppHttpRouter from "./WorkbenchAppHttpRouter.ts";

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no address.");
  return `http://127.0.0.1:${address.port}`;
}

async function fixtureRouter(
  errors: string[],
  legacyOrigin: string,
  appOrigin = "http://127.0.0.1:43210",
) {
  const output = await mkdtemp(path.join(os.tmpdir(), "workbench-app-router-"));
  await mkdir(path.join(output, "tab-icons"), { recursive: true });
  await writeFile(path.join(output, "index.html"), "<main>app</main>", "utf8");
  await writeFile(path.join(output, "tab-icons", "default-256.png"), "icon", "utf8");
  const state = {
    read: () => ({
      rows: { lastLaunchTarget: [{ daemon_registration_id: "daemon", deleted: 0, id: "singleton", project_id: "web/workbench", revision: 1 }] },
    }),
  } as unknown as WorkbenchAppStateController;
  return new WorkbenchAppHttpRouter({
    appPort: {
      read: () => ({
        appOrigin,
        currentPort: Number(new URL(appOrigin).port),
        editable: true,
        source: "random",
      }),
      update: async () => ({
        appOrigin: "http://127.0.0.1:43211",
        currentPort: 43_211,
        editable: true,
        source: "setting",
      }),
    },
    legacyOrigin,
    logger: new WorkbenchAppLogger({ color: false, writeError: (value) => errors.push(value) }),
    outputDirectoryPath: output,
    state,
  });
}

test("admits bounded browser logs under the client domain", async (context) => {
  const errors: string[] = [];
  const router = await fixtureRouter(errors, "http://127.0.0.1:1");
  await router.start();
  context.after(() => router.close());
  const server = new HttpServer({ handleRequest: (request, response) => router.handle(request, response), hostname: "127.0.0.1" });
  context.after(async () => await server.close());
  const { url } = await server.start();
  const response = await fetch(`${url}/api/workbench-client-log`, {
    body: JSON.stringify({ entries: [{ level: "warn", message: "hello" }] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 202);
  assert.match(errors[0] ?? "", / client \[warn\] hello/u);
  assert.equal((await fetch(`${url}/api/workbench-client-log`, {
    body: JSON.stringify({ entries: [{ level: "info", message: "nope" }] }),
    method: "POST",
  })).status, 400);
});

test("serves SPA and launch routes while unrelated APIs remain legacy-owned", async (context) => {
  const legacy = createServer((_request, response) => response.end("legacy"));
  context.after(() => legacy.close());
  const errors: string[] = [];
  const router = await fixtureRouter(errors, await listen(legacy));
  await router.start();
  context.after(() => router.close());
  const server = new HttpServer({ handleRequest: (request, response) => router.handle(request, response), hostname: "127.0.0.1" });
  context.after(async () => await server.close());
  const { url } = await server.start();
  assert.equal(await (await fetch(`${url}/project/one`, { headers: { Accept: "text/html" } })).text(), "<main>app</main>");
  const icon = await fetch(`${url}/tab-icons/default-256.png`);
  assert.equal(icon.headers.get("content-type"), "image/png");
  assert.equal(await icon.text(), "icon");
  const launch = await fetch(`${url}/launch`, { redirect: "manual" });
  assert.equal(launch.headers.get("location"), "/web/workbench");
  assert.equal(await (await fetch(`${url}/api/projects`)).text(), "legacy");
});

test("rejects a legacy proxy target that resolves to the app listener", async (context) => {
  const errors: string[] = [];
  const appOrigin = "http://127.0.0.1:43210";
  const router = await fixtureRouter(errors, appOrigin, appOrigin);
  await router.start();
  context.after(() => router.close());
  const server = new HttpServer({ handleRequest: (request, response) => router.handle(request, response), hostname: "127.0.0.1" });
  context.after(async () => await server.close());
  const { url } = await server.start();

  const response = await fetch(`${url}/api/projects`);

  assert.equal(response.status, 502);
  assert.equal(errors.filter((message) => message.includes("Refused recursive legacy request")).length, 1);
});
