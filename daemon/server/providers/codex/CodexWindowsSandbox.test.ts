/*
 * No exports. Tests protect which sandbox level agent shells get and the elevated setup flight.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import CodexWindowsSandbox from "./CodexWindowsSandbox";

type Readiness = "ready" | "notConfigured" | "updateRequired";

function fakeAppServer({ receipt = null, readiness = "ready" }: { receipt?: "elevated" | "unelevated" | null; readiness?: Readiness } = {}) {
  const state = { receipt, readiness, setupStart: async (): Promise<unknown> => ({ started: true }) };
  const calls: string[] = [];
  const request = async (method: string, _params: object): Promise<unknown> => {
    calls.push(method);
    if (method === "config/read") return { config: state.receipt ? { windows: { sandbox: state.receipt } } : {} };
    if (method === "windowsSandbox/readiness") return { status: state.readiness };
    if (method === "windowsSandbox/setupStart") return await state.setupStart();
    throw new Error(`unexpected ${method}`);
  };
  return { state, calls, sandbox: new CodexWindowsSandbox({ request, platform: "win32" }) };
}

const completed = (success: boolean, error: string | null = null) => ({
  method: "windowsSandbox/setupCompleted", params: { mode: "elevated", success, error },
});

test("non-Windows daemons are unsupported and ask Codex nothing", async () => {
  const calls: string[] = [];
  const sandbox = new CodexWindowsSandbox({ platform: "linux", request: async method => { calls.push(method); return {}; } });
  assert.deepEqual(await sandbox.status(), { state: "unsupported" });
  assert.equal(await sandbox.level("/work"), "restricted-token");
  await assert.rejects(sandbox.setUp());
  assert.deepEqual(calls, []);
});

test("without Codex's elevated receipt shells use the restricted-token sandbox", async () => {
  for (const receipt of [null, "unelevated"] as const) {
    const { sandbox, calls } = fakeAppServer({ receipt });
    assert.deepEqual(await sandbox.status(), { state: "not-set-up" });
    assert.equal(await sandbox.level("C:/work"), "restricted-token");
    assert.ok(!calls.includes("windowsSandbox/readiness"));
  }
});

test("shells run elevated only while Codex reports its elevated setup ready", async () => {
  const { sandbox, state } = fakeAppServer({ receipt: "elevated" });
  assert.deepEqual(await sandbox.status(), { state: "ready" });
  assert.equal(await sandbox.level("C:/work"), "elevated");
  for (const readiness of ["updateRequired", "notConfigured"] as const) {
    state.readiness = readiness;
    assert.deepEqual(await sandbox.status(), { state: "update-required" });
    assert.equal(await sandbox.level("C:/work"), "restricted-token");
  }
});

test("setup completes through Codex's notification and concurrent requests share one flight", async () => {
  const { sandbox, state, calls } = fakeAppServer();
  const first = sandbox.setUp();
  const second = sandbox.setUp();
  assert.deepEqual(await sandbox.status(), { state: "setting-up" });
  state.receipt = "elevated";
  sandbox.observe({ method: "windowsSandbox/setupCompleted", params: { mode: "unelevated", success: true, error: null } });
  sandbox.observe(completed(true));
  assert.deepEqual(await first, { state: "ready" });
  assert.deepEqual(await second, { state: "ready" });
  assert.equal(calls.filter(method => method === "windowsSandbox/setupStart").length, 1);
});

test("a failed setup reports Codex's error until a later attempt starts", async () => {
  const { sandbox, state } = fakeAppServer();
  const failed = sandbox.setUp();
  sandbox.observe(completed(false, "UAC declined"));
  assert.deepEqual(await failed, { state: "failed", error: "UAC declined" });
  assert.deepEqual(await sandbox.status(), { state: "failed", error: "UAC declined" });

  state.setupStart = async () => { throw new Error("setup request rejected"); };
  assert.deepEqual(await sandbox.setUp(), { state: "failed", error: "setup request rejected" });

  state.setupStart = async () => ({ started: true });
  const retried = sandbox.setUp();
  state.receipt = "elevated";
  sandbox.observe(completed(true));
  assert.deepEqual(await retried, { state: "ready" });
});

test("disposal ends a pending setup instead of leaving its request waiting", async () => {
  const { sandbox } = fakeAppServer();
  const pending = sandbox.setUp();
  sandbox.dispose();
  await assert.rejects(pending, /Recheck its status/u);
  assert.deepEqual(await sandbox.status(), { state: "not-set-up" });
});
