/*
 * No production exports. Tests protect client-log admission, SPA serving, launch restoration, and legacy proxy ownership.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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

async function fixtureRouter(errors: string[], legacyOrigin: string) {
  const output = await mkdtemp(path.join(os.tmpdir(), "workbench-app-router-"));
  await writeFile(path.join(output, "index.html"), "<main>app</main>", "utf8");
  const state = {
    read: () => ({
      rows: { lastLaunchTarget: [{ daemon_registration_id: "daemon", deleted: 0, id: "singleton", project_id: "project one", revision: 1 }] },
    }),
  } as unknown as WorkbenchAppStateController;
  return new WorkbenchAppHttpRouter({
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
  const launch = await fetch(`${url}/launch`, { redirect: "manual" });
  assert.equal(launch.headers.get("location"), "/project/project%20one");
  assert.equal(await (await fetch(`${url}/api/projects`)).text(), "legacy");
});
