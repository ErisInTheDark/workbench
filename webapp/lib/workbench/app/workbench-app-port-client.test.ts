/*
 * No production exports. Tests protect old-process compatibility, browser schema admission, and origin-only redirects.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkbenchAppPortRedirectUrl,
  readWorkbenchAppPort,
  updateWorkbenchAppPort,
} from "./workbench-app-port-client";

function fetcher(response: Response) {
  return (async () => response) as typeof fetch;
}

test("reads typed port state and degrades cleanly when the old process has no route", async () => {
  const snapshot = {
    appOrigin: "http://127.0.0.1:43210",
    currentPort: 43_210,
    editable: true,
    source: "random",
  };
  assert.deepEqual(
    await readWorkbenchAppPort(fetcher(Response.json(snapshot)), "http://127.0.0.1:43210/project"),
    snapshot,
  );
  assert.deepEqual(
    await readWorkbenchAppPort(fetcher(new Response("", { status: 404 })), "http://127.0.0.1:43210/project"),
    { ...snapshot, editable: false, source: "unavailable" },
  );
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

test("redirects to the new origin without losing route, query, or hash", () => {
  assert.equal(
    createWorkbenchAppPortRedirectUrl(
      "http://127.0.0.1:43210/project/workbench/settings/global?panel=app#port",
      "http://127.0.0.1:43211",
    ),
    "http://127.0.0.1:43211/project/workbench/settings/global?panel=app#port",
  );
});
