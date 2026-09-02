/*
 * No production exports. Real HTTP wards protect app-settings admission, process-applied state, and bounded failures.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import HttpServer from "workbench-shared/http/HttpServer";
import { WORKBENCH_APP_SETTINGS_PATH } from "workbench-shared/http/workbench-app-settings";

import WorkbenchAppSettingsRoutes from "./WorkbenchAppSettingsRoutes.ts";

async function fixture(
  context: TestContext,
  options: ConstructorParameters<typeof WorkbenchAppSettingsRoutes>[0],
) {
  const routes = new WorkbenchAppSettingsRoutes(options);
  const server = new HttpServer({
    handleRequest: async (request, response) => {
      const url = new URL(request.url ?? "/", "http://workbench.local");
      if (!await routes.handle(request, response, url)) {
        response.writeHead(404);
        response.end();
      }
    },
    hostname: "127.0.0.1",
  });
  context.after(async () => await server.close());
  return await server.start();
}

test("reads applied mode and persists a valid requested mode", async (context) => {
  let requested = false;
  const updates: boolean[] = [];
  const address = await fixture(context, {
    readAppliedReactDevelopmentMode: () => false,
    readRequestedReactDevelopmentMode: () => requested,
    writeRequestedReactDevelopmentMode: async (value) => {
      updates.push(value);
      requested = value;
    },
  });

  assert.deepEqual(await (await fetch(`${address.url}${WORKBENCH_APP_SETTINGS_PATH}`)).json(), {
    appliedReactDevelopmentMode: false,
    requestedReactDevelopmentMode: false,
  });
  const update = await fetch(`${address.url}${WORKBENCH_APP_SETTINGS_PATH}`, {
    body: JSON.stringify({ reactDevelopmentMode: true }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), {
    appliedReactDevelopmentMode: false,
    requestedReactDevelopmentMode: true,
  });
  assert.deepEqual(updates, [true]);
});

test("rejects invalid input and reports unexpected persistence failures", async (context) => {
  const diagnostics: string[] = [];
  const address = await fixture(context, {
    onDiagnostic: (message) => diagnostics.push(message),
    readAppliedReactDevelopmentMode: () => false,
    readRequestedReactDevelopmentMode: () => false,
    writeRequestedReactDevelopmentMode: async () => {
      throw new Error("database exploded with secret details");
    },
  });

  assert.equal((await fetch(`${address.url}${WORKBENCH_APP_SETTINGS_PATH}`, {
    body: JSON.stringify({ reactDevelopmentMode: "yes" }),
    method: "PUT",
  })).status, 400);
  assert.equal((await fetch(`${address.url}${WORKBENCH_APP_SETTINGS_PATH}`, {
    body: JSON.stringify({ reactDevelopmentMode: true }),
    method: "PUT",
  })).status, 500);
  assert.equal((await fetch(`${address.url}${WORKBENCH_APP_SETTINGS_PATH}`, { method: "DELETE" })).status, 405);
  assert.equal(diagnostics.length, 1);
});
