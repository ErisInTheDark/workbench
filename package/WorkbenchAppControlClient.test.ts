/*
 * No production exports. Protect app-publication readiness, replacement and process-bound Quit targeting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WorkbenchAppControlClient from "./WorkbenchAppControlClient.ts";
import type { WorkbenchServiceEndpoint } from "../shared/http/workbench-service.ts";

function endpoint(instanceId: string): WorkbenchServiceEndpoint {
  return { version: 1, instanceId, pid: 1234, origin: "http://127.0.0.1:4321", token: "a".repeat(64) };
}

function fixture() {
  let current: WorkbenchServiceEndpoint | null = null;
  let health = async () => {};
  const urls: string[] = [];
  const warnings: string[] = [];
  const client = new WorkbenchAppControlClient({
    endpointPath: "/unused/runtime.json",
    warn: message => { warnings.push(message); },
    observe: () => () => {},
    read: async () => current,
    verify: async () => { await health(); },
    fetcher: async input => {
      urls.push(typeof input === "string" ? input : String(input));
      return new Response(null, { status: 200 });
    },
  });
  return {
    client, urls, warnings,
    set current(value: WorkbenchServiceEndpoint | null) { current = value; },
    failHealth() { health = async () => { throw new Error("unreachable"); }; },
  };
}

test("readiness follows the app publication and quit targets the current instance", async () => {
  const f = fixture();
  const transitions: boolean[] = [];
  f.client.subscribe(() => transitions.push(f.client.getSnapshot().ready));
  await f.client.start();
  assert.deepEqual(f.client.getSnapshot(), { ready: false, instanceId: null });

  f.current = endpoint("one");
  await f.client.refresh();
  assert.deepEqual(f.client.getSnapshot(), { ready: true, instanceId: "one" });

  f.current = endpoint("two");
  await f.client.refresh();
  assert.deepEqual(f.client.getSnapshot(), { ready: true, instanceId: "two" });

  await f.client.quit();
  assert.equal(f.urls.at(-1), "http://127.0.0.1:4321/_workbench-control/quit/two");

  f.current = null;
  await f.client.refresh();
  assert.deepEqual(f.client.getSnapshot(), { ready: false, instanceId: null });
  assert.deepEqual(transitions, [true, true, false]);
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
