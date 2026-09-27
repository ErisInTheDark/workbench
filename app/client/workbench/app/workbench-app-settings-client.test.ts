/*
 * No production exports. Tests protect old-process compatibility and browser schema admission for app settings.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  readWorkbenchAppSettings,
  updateWorkbenchAppSettings,
} from "./workbench-app-settings-client";
import type WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";

function fetcher(response: Response) {
  return (async () => response) as typeof fetch;
}

test("reads typed app settings and degrades cleanly when the old process has no route", async () => {
  const snapshot = {
    appliedReactDevelopmentMode: false,
    requestedReactDevelopmentMode: true,
  };
  assert.deepEqual(await readWorkbenchAppSettings(fetcher(Response.json(snapshot))), snapshot);
  assert.equal(await readWorkbenchAppSettings(fetcher(new Response("", { status: 404 }))), null);
});

test("updates React mode and rejects malformed browser-boundary responses", async () => {
  const snapshot = {
    appliedReactDevelopmentMode: false,
    requestedReactDevelopmentMode: true,
  };
  assert.deepEqual(
    await updateWorkbenchAppSettings(true, fetcher(Response.json(snapshot))),
    snapshot,
  );

  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      updateWorkbenchAppSettings(true, fetcher(Response.json({
        appliedReactDevelopmentMode: "false",
        requestedReactDevelopmentMode: true,
      }))),
      /response was invalid/u,
    );
  } finally {
    console.error = originalError;
  }
});

test("new-process settings reads and writes use RPC without HTTP", async () => {
  const methods: string[] = [];
  const snapshot = { appliedReactDevelopmentMode: false, requestedReactDevelopmentMode: true };
  const rpc = {
    available: true,
    requestRaw: async (intent: { method: string }) => {
      methods.push(intent.method);
      return snapshot;
    },
  } as unknown as WorkbenchAppRpcClient;
  const noHttp: typeof fetch = async () => { throw new Error("Unexpected settings HTTP."); };
  assert.deepEqual(await readWorkbenchAppSettings(noHttp, rpc), snapshot);
  assert.deepEqual(await updateWorkbenchAppSettings(true, noHttp, rpc), snapshot);
  assert.deepEqual(methods, ["app/settings/read", "app/settings/update"]);
});
