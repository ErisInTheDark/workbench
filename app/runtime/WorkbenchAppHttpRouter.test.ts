/*
 * No production exports. Tests protect client-log admission, SPA and launch serving, and API ownership.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import HttpServer from "workbench-shared/http/HttpServer";

import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import type WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import WorkbenchAppHttpRouter from "./WorkbenchAppHttpRouter.ts";

async function fixtureRouter(
  errors: string[],
  appOrigin = "http://127.0.0.1:43210",
) {
  const output = await mkdtemp(path.join(os.tmpdir(), "workbench-app-router-"));
  await mkdir(path.join(output, "tab-icons"), { recursive: true });
  await writeFile(path.join(output, "index.html"), "<main>app</main>", "utf8");
  await writeFile(path.join(output, "tab-icons", "default-256.png"), "icon", "utf8");
  const state = {} as WorkbenchBrowserStateRegistry;
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
    logger: new WorkbenchProcessLogger({ color: false, writeError: (value) => errors.push(value) }),
    outputDirectoryPath: output,
    state,
  });
}

test("admits bounded browser logs under the client domain", async (context) => {
  const errors: string[] = [];
  const router = await fixtureRouter(errors);
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

test("serves SPA and launch routes while unknown APIs return not found", async (context) => {
  const errors: string[] = [];
  const router = await fixtureRouter(errors);
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
  assert.equal(launch.headers.get("location"), null);
  assert.equal(await launch.text(), "<main>app</main>");
  const missingApi = await fetch(`${url}/api/projects`);
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), { error: "Workbench app route not found." });
});
