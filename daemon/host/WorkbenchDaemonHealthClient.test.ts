/*
 * No production exports. Tests protect typed WebSocket health success, failures, deadlines, cancellation, and disposal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { CodexJsonRpcResponse } from "../../shared/codex/protocol.ts";
import WorkbenchDaemonHealthClient from "./WorkbenchDaemonHealthClient.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fixture(response: Promise<CodexJsonRpcResponse<unknown>>) {
  let disposed = 0;
  const requests: Array<{ method: string; params: object }> = [];
  const urls: string[] = [];
  const client = new WorkbenchDaemonHealthClient({
    createClient: () => ({
      connectSocket: async (url) => { urls.push(url); },
      dispose: () => { disposed += 1; },
      sendRequest: async (message) => {
        requests.push(message);
        return await response;
      },
    }),
  });
  return { client, disposed: () => disposed, requests, urls };
}

test("performs one typed health request and disposes the socket", async () => {
  const target = fixture(Promise.resolve({ id: 1, result: { ok: true } }));

  assert.deepEqual(await target.client.probe("ws://127.0.0.1:4500", 1_000), { ok: true });
  assert.deepEqual(target.urls, ["ws://127.0.0.1:4500"]);
  assert.deepEqual(target.requests, [{ method: "workbench/daemon/health", params: {} }]);
  assert.equal(target.disposed(), 1);
});

test("surfaces RPC and contract failures before disposing", async () => {
  const rejected = fixture(Promise.resolve({ error: { code: -32000, message: "not healthy" }, id: 1 }));
  await assert.rejects(rejected.client.probe("ws://test", 1_000), /not healthy/u);
  assert.equal(rejected.disposed(), 1);

  const invalid = fixture(Promise.resolve({ id: 1, result: {} }));
  await assert.rejects(invalid.client.probe("ws://test", 1_000), /response was invalid/u);
  assert.equal(invalid.disposed(), 1);
});

test("bounds and cancels an unsettled health request", async () => {
  const pending = deferred<CodexJsonRpcResponse<unknown>>();
  const scheduled: Array<() => void> = [];
  let disposed = 0;
  const client = new WorkbenchDaemonHealthClient({
    clearTimeout: () => {},
    createClient: () => ({
      connectSocket: async () => {},
      dispose: () => { disposed += 1; },
      sendRequest: async () => await pending.promise,
    }),
    setTimeout: (callback) => {
      scheduled.push(callback);
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
  });
  const timedOut = client.probe("ws://test", 20_000);
  assert.equal(scheduled.length, 1);
  scheduled[0]!();
  await assert.rejects(timedOut, /exceeded 20000ms/u);
  assert.equal(disposed, 1);

  const controller = new AbortController();
  const cancelled = client.probe("ws://test", 20_000, controller.signal);
  controller.abort(new Error("runner stopped"));
  await assert.rejects(cancelled, /runner stopped/u);
  assert.equal(disposed, 2);
});
