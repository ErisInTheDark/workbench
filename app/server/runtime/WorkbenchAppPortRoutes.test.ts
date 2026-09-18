/*
 * No production exports. Real HTTP wards protect app-port admission, lifecycle delegation, and bounded failures.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import HttpServer from "workbench-shared/http/HttpServer";
import { WORKBENCH_APP_PORT_PATH, type WorkbenchAppPortSnapshot } from "workbench-shared/http/workbench-app-port";

import type { WorkbenchAppPortControl } from "../WorkbenchApp.ts";
import WorkbenchAppPortRoutes from "./WorkbenchAppPortRoutes.ts";

const current: WorkbenchAppPortSnapshot = {
  appOrigin: "http://127.0.0.1:43210",
  currentPort: 43_210,
  editable: true,
  source: "random",
};

async function fixture(context: TestContext, appPort: WorkbenchAppPortControl, diagnostics: string[] = [], stableOrigin?: () => string | null, canUpdate?: () => boolean) {
  const routes = new WorkbenchAppPortRoutes({
    appPort,
    stableOrigin,
    canUpdate,
    onDiagnostic: (message) => diagnostics.push(message),
  });
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

test("combined networking changes exclude independent port writes", async context => {
  let available = false;
  let writes = 0;
  const address = await fixture(context, { read: () => current, update: async () => { writes++; return current; } }, [], undefined, () => available);
  const update = () => fetch(`${address.url}${WORKBENCH_APP_PORT_PATH}`, {
    method: "PUT", body: JSON.stringify({ port: 43211 }),
  });
  assert.equal((await update()).status, 409);
  assert.equal(writes, 0);
  available = true;
  assert.equal((await update()).status, 200);
  assert.equal(writes, 1);
});

test("reads the active port and delegates a valid update", async (context) => {
  const updates: number[] = [];
  const moved = { ...current, appOrigin: "http://127.0.0.1:43211", currentPort: 43_211, source: "setting" as const };
  const address = await fixture(context, {
    read: () => current,
    update: async (port) => {
      updates.push(port);
      return moved;
    },
  });

  const readResponse = await fetch(`${address.url}${WORKBENCH_APP_PORT_PATH}`);
  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), current);
  const updateResponse = await fetch(`${address.url}${WORKBENCH_APP_PORT_PATH}`, {
    body: JSON.stringify({ port: 43_211 }),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(await updateResponse.json(), moved);
  assert.deepEqual(updates, [43_211]);
});

test("rejects invalid input and unsupported methods before lifecycle delegation", async (context) => {
  const updates: number[] = [];
  const address = await fixture(context, {
    read: () => current,
    update: async (port) => {
      updates.push(port);
      return current;
    },
  });
  const invalid = await fetch(`${address.url}${WORKBENCH_APP_PORT_PATH}`, {
    body: JSON.stringify({ port: 0 }),
    method: "PUT",
  });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(`${address.url}${WORKBENCH_APP_PORT_PATH}`, { method: "DELETE" })).status, 405);
  assert.deepEqual(updates, []);
});

test("distinguishes expected port conflicts from unexpected owner failures", async (context) => {
  const conflictAddress = await fixture(context, {
    read: () => ({ ...current, editable: false, source: "environment" }),
    update: async () => {
      throw new Error("Workbench app port is controlled by WORKBENCH_APP_PORT.");
    },
  });
  assert.equal((await fetch(`${conflictAddress.url}${WORKBENCH_APP_PORT_PATH}`, {
    body: JSON.stringify({ port: 43_211 }),
    method: "PUT",
  })).status, 409);

  const diagnostics: string[] = [];
  const failedAddress = await fixture(context, {
    read: () => current,
    update: async () => {
      throw new Error("Workbench app port persistence and candidate cleanup failed.");
    },
  }, diagnostics);
  assert.equal((await fetch(`${failedAddress.url}${WORKBENCH_APP_PORT_PATH}`, {
    body: JSON.stringify({ port: 43_211 }),
    method: "PUT",
  })).status, 500);
  assert.equal(diagnostics.length, 1);
});

test("only versioned clients receive stable network-origin metadata after a port move", async context => {
  const stableOrigin = "https://desktop.wb.inthedark.boo";
  const moved = { ...current, currentPort: 43211, appOrigin: "http://127.0.0.1:43211" };
  const address = await fixture(context, { read: () => current, update: async () => moved }, [], () => stableOrigin);
  assert.deepEqual(await (await fetch(`${address.url}${WORKBENCH_APP_PORT_PATH}`)).json(), current);
  const response = await fetch(`${address.url}${WORKBENCH_APP_PORT_PATH}?version=2`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ port: 43211 }),
  });
  assert.deepEqual(await response.json(), { ...moved, stableOrigin });
});
