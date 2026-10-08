/*
 * No production exports. Protect app-publication readiness, replacement, pushed runtime events and process-bound actions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchAppControlClient from "./WorkbenchAppControlClient.ts";
import type { WorkbenchServiceEndpoint } from "../shared/http/workbench-service.ts";
import type { WorkbenchAppControlRuntime } from "../shared/http/workbench-app-control.ts";
import { IDLE_RELOAD_OPERATION } from "../shared/reload/workbench-reload.ts";

function endpoint(instanceId: string): WorkbenchServiceEndpoint {
  return { version: 1, instanceId, pid: 1234, origin: "http://127.0.0.1:4321", token: "a".repeat(64) };
}

const runtime = (dirty: boolean): WorkbenchAppControlRuntime => ({ dirty, destructive: false, update: null, operation: IDLE_RELOAD_OPERATION });

function fixture() {
  let current: WorkbenchServiceEndpoint | null = null;
  let health = async () => {};
  const requests: Array<{ url: string; body: string | null }> = [];
  const warnings: string[] = [];
  const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const client = new WorkbenchAppControlClient({
    endpointPath: "/unused/runtime.json",
    warn: message => { warnings.push(message); },
    observe: () => () => {},
    read: async () => current,
    verify: async () => { await health(); },
    fetcher: async (input, init) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.endsWith("/runtime/events")) {
        return new Response(new ReadableStream<Uint8Array>({ start: controller => { streams.push(controller); } }), { status: 200 });
      }
      requests.push({ url, body: typeof init?.body === "string" ? init.body : null });
      return new Response(null, { status: 200 });
    },
  });
  const emit = (index: number, value: WorkbenchAppControlRuntime) =>
    streams[index]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
  return {
    client, requests, warnings, streams, emit,
    set current(value: WorkbenchServiceEndpoint | null) { current = value; },
    failHealth() { health = async () => { throw new Error("unreachable"); }; },
  };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("readiness follows the app publication and actions target the current instance", async () => {
  const f = fixture();
  const transitions: boolean[] = [];
  f.client.subscribe(() => transitions.push(f.client.getSnapshot().ready));
  await f.client.start();
  assert.deepEqual(f.client.getSnapshot(), { ready: false, instanceId: null, runtime: null });

  f.current = endpoint("one");
  await f.client.refresh();
  assert.deepEqual(f.client.getSnapshot(), { ready: true, instanceId: "one", runtime: null });

  f.current = endpoint("two");
  await f.client.refresh();
  assert.deepEqual(f.client.getSnapshot(), { ready: true, instanceId: "two", runtime: null });

  await f.client.quit();
  await f.client.reloadAll();
  await f.client.pull(true);
  assert.deepEqual(f.requests, [
    { url: "http://127.0.0.1:4321/_workbench-control/quit/two", body: null },
    { url: "http://127.0.0.1:4321/_workbench-control/reload-all", body: null },
    { url: "http://127.0.0.1:4321/_workbench-control/pull", body: JSON.stringify({ reload: true }) },
  ]);

  f.current = null;
  await f.client.refresh();
  assert.deepEqual(f.client.getSnapshot(), { ready: false, instanceId: null, runtime: null });
  assert.deepEqual(transitions, [true, true, false]);
  await f.client.close();
});

test("runtime events belong to the instance that sent them", async () => {
  const f = fixture();
  f.current = endpoint("one");
  await f.client.start();
  await flush();
  f.emit(0, runtime(true));
  await flush();
  assert.deepEqual(f.client.getSnapshot().runtime, runtime(true));

  f.current = endpoint("two");
  await f.client.refresh();
  await flush();
  assert.equal(f.client.getSnapshot().runtime, null);
  // Replacement drops the old summary and follows the new instance's own stream.
  f.emit(1, runtime(false));
  await flush();
  assert.deepEqual(f.client.getSnapshot().runtime, runtime(false));
  await f.client.close();
});

test("losing a reachable app drops readiness and warns once", async () => {
  const f = fixture();
  f.current = endpoint("one");
  await f.client.start();
  assert.equal(f.client.getSnapshot().ready, true);
  f.failHealth();
  await f.client.refresh();
  assert.equal(f.client.getSnapshot().ready, false);
  await f.client.refresh();
  assert.equal(f.warnings.length, 1);
  await f.client.close();
});
