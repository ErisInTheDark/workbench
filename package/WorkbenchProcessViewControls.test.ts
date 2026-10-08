/*
 * No production exports. Protect host/app availability composition and lifecycle intent routing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import createWorkbenchProcessViewControls, {
  type ProcessViewAppClient, type ProcessViewHostClient, type ProcessViewHostIntent,
} from "./WorkbenchProcessViewControls.ts";
import type { WorkbenchAppControlRuntime } from "../shared/http/workbench-app-control.ts";
import { IDLE_RELOAD_OPERATION } from "../shared/reload/workbench-reload.ts";

type Phase = ReturnType<ProcessViewHostClient["getSnapshot"]>["phase"];
type DaemonState = "sleeping" | "starting" | "ready" | "failed";

const appRuntime: WorkbenchAppControlRuntime = { dirty: true, destructive: false, update: null, operation: IDLE_RELOAD_OPERATION };

function fixture() {
  const requests: ProcessViewHostIntent[] = [];
  const calls: string[] = [];
  const hostState: { phase: Phase; daemon: DaemonState } = { phase: "ready", daemon: "ready" };
  const appState: { ready: boolean; instanceId: string | null; runtime: WorkbenchAppControlRuntime | null } = {
    ready: true, instanceId: "app-1", runtime: appRuntime,
  };
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
    getSnapshot: () => ({ ready: appState.ready, instanceId: appState.instanceId, runtime: appState.runtime }),
    launchUrl: async () => "https://desk.wb.inthedark.boo/launch",
    quit: async () => { calls.push("quit"); },
    reloadAll: async () => { calls.push("reload-all"); },
    pull: async reload => { calls.push(`pull ${reload}`); },
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
  assert.deepEqual(controls.snapshot(), { host: true, daemon: true, app: true, runtime: appRuntime });
  f.hostState.daemon = "sleeping";
  assert.deepEqual(controls.snapshot(), { host: true, daemon: false, app: true, runtime: appRuntime });
  f.hostState.phase = "failed";
  f.appState.ready = false;
  // A gone app's last summary is never shown as live.
  assert.deepEqual(controls.snapshot(), { host: false, daemon: false, app: false, runtime: null });
});

test("reload-all and pull-only require the app and pull without reloading", async () => {
  const f = fixture();
  const controls = await f.controls;
  await controls.reloadAll();
  await controls.pullChanges();
  assert.deepEqual(f.calls.filter(call => call === "reload-all" || call.startsWith("pull")), ["reload-all", "pull false"]);
  f.appState.ready = false;
  await assert.rejects(controls.reloadAll(), /app is not running/u);
  await assert.rejects(controls.pullChanges(), /app is not running/u);
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
  assert.ok(f.calls.includes("open https://desk.wb.inthedark.boo/launch"));
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
