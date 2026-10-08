/*
 * No production exports. Protect host/app availability composition and lifecycle intent routing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import createWorkbenchProcessViewControls, {
  type ProcessViewAppClient, type ProcessViewHostClient, type ProcessViewHostIntent,
} from "./WorkbenchProcessViewControls.ts";

type Phase = ReturnType<ProcessViewHostClient["getSnapshot"]>["phase"];
type DaemonState = "sleeping" | "starting" | "ready" | "failed";

function fixture() {
  const requests: ProcessViewHostIntent[] = [];
  const calls: string[] = [];
  const hostState: { phase: Phase; daemon: DaemonState } = { phase: "ready", daemon: "ready" };
  const appState: { ready: boolean; instanceId: string | null } = { ready: true, instanceId: "app-1" };
  const host: ProcessViewHostClient = {
    start: async () => {},
    close: async () => { calls.push("close-host"); },
    subscribe: () => () => {},
    getSnapshot: () => ({
      phase: hostState.phase,
      snapshot: hostState.phase === "ready" ? { identity: { state: hostState.daemon } } : null,
    }),
    request: async intent => {
      requests.push(intent);
      if (intent.method === "service/process/read") {
        return { kind: "process", id: "1", instanceId: "host-1", logDirectory: "/logs", logPrefix: "workbench-host" };
      }
      return { kind: "ok", id: "1" };
    },
  };
  const app: ProcessViewAppClient = {
    start: async () => {},
    close: async () => { calls.push("close-app"); },
    subscribe: () => () => {},
    getSnapshot: () => ({ ready: appState.ready, instanceId: appState.instanceId }),
    origin: async () => "http://127.0.0.1:45409",
    quit: async () => { calls.push("quit"); },
  };
  const controls = createWorkbenchProcessViewControls({
    dataRoot: "/data",
    repositoryRoot: "/repo",
    warn: () => {},
    createHostClient: () => host,
    createAppClient: () => app,
    startApp: async () => { calls.push("start-app"); },
    openUrl: async url => { calls.push(`open ${url}`); },
  });
  return { controls, requests, calls, hostState, appState };
}

test("availability composes host, daemon and app truth", async () => {
  const f = fixture();
  const controls = await f.controls;
  assert.deepEqual(controls.snapshot(), { host: true, daemon: true, app: true });
  f.hostState.daemon = "sleeping";
  assert.deepEqual(controls.snapshot(), { host: true, daemon: false, app: true });
  f.hostState.phase = "failed";
  f.appState.ready = false;
  assert.deepEqual(controls.snapshot(), { host: false, daemon: false, app: false });
});

test("kill daemon restarts with the live host identity", async () => {
  const f = fixture();
  const controls = await f.controls;
  await controls.killDaemon();
  assert.deepEqual(f.requests, [
    { method: "service/process/read" },
    { method: "service/daemon/restart", instanceId: "host-1" },
  ]);
});

test("kill host and force stop share the live identity", async () => {
  const f = fixture();
  const controls = await f.controls;
  await controls.killHost();
  await controls.forceStopHost();
  assert.deepEqual(f.requests.slice(1), [
    { method: "service/stop", instanceId: "host-1" },
    { method: "service/process/read" },
    { method: "service/emergency/stop", instanceId: "host-1" },
  ]);
});

test("host controls reject while the host is unavailable", async () => {
  const f = fixture();
  const controls = await f.controls;
  f.hostState.phase = "failed";
  await assert.rejects(controls.killDaemon(), /host is not running/u);
  await assert.rejects(controls.killHost(), /host is not running/u);
});

test("kill app, open app and start app follow app availability", async () => {
  const f = fixture();
  const controls = await f.controls;
  await assert.rejects(controls.startApp(), /already running/u);
  await controls.openApp();
  assert.ok(f.calls.includes("open http://127.0.0.1:45409"));
  await controls.killApp();
  assert.ok(f.calls.includes("quit"));
  f.appState.ready = false;
  await assert.rejects(controls.killApp(), /app is not running/u);
  await assert.rejects(controls.openApp(), /app is not running/u);
  await controls.startApp();
  assert.ok(f.calls.includes("start-app"));
});

test("close releases both clients once", async () => {
  const f = fixture();
  const controls = await f.controls;
  await controls.close();
  await controls.close();
  assert.deepEqual(f.calls.filter(call => call.startsWith("close-")), ["close-host", "close-app"]);
});
