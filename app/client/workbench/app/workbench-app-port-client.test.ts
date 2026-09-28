/*
 * No production exports. Tests protect browser schema admission and origin-only redirects.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchAppPortRedirectUrl,
  readWorkbenchAppPort,
  updateWorkbenchAppPort,
} from "./workbench-app-port-client";
import { createWorkspaceClientFixture } from "./workspace-client-fixture";

function fetcher(response: Response) {
  return (async () => response) as typeof fetch;
}

test("reads the app-owned port state through the maintained connection", async context => {
  const fixture = createWorkspaceClientFixture();
  context.after(() => fixture.dispose());
  const socket = await fixture.open();
  const snapshot = {
    appOrigin: "http://127.0.0.1:43210",
    currentPort: 43_210,
    editable: true,
    source: "random",
  };
  const reading = readWorkbenchAppPort(fixture.rpc);
  socket.reply(await socket.request("app/port/read"), snapshot);
  assert.deepEqual(await reading, { ...snapshot, stableOrigin: null });
});

test("rejects malformed browser-boundary responses", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      updateWorkbenchAppPort(43_211, fetcher(Response.json({
        appOrigin: "http://127.0.0.1:43211",
        currentPort: "43211",
        editable: true,
        source: "setting",
      }))),
      /response was invalid/u,
    );
  } finally {
    console.error = originalError;
  }
});

test("redirects to the new origin without losing route, query, hash, or stable browser identity", () => {
  assert.equal(
    createWorkbenchAppPortRedirectUrl(
      "http://127.0.0.1:43210/project/workbench/settings/global?panel=app#port",
      "http://127.0.0.1:43211",
      "10000000-0000-4000-8000-000000000001",
    ),
    "http://127.0.0.1:43211/project/workbench/settings/global?panel=app&workbenchBrowserStateId=10000000-0000-4000-8000-000000000001#port",
  );
});

test("port moves preserve private HTTPS and static tailnet origins while direct tailnet URLs follow the new port", () => {
  for (const origin of ["https://desktop.wb.inthedark.boo", "http://100.80.0.1:8080"]) {
    assert.equal(createWorkbenchAppPortRedirectUrl(`${origin}/settings?view=network#port`, "http://127.0.0.1:4300", undefined, origin),
      `${origin}/settings?view=network#port`);
  }
  assert.equal(createWorkbenchAppPortRedirectUrl("http://100.80.0.1:4200/settings", "http://127.0.0.1:4300"),
    "http://100.80.0.1:4300/settings");
});
