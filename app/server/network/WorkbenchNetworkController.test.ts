/* No production exports. Protect optional-mode isolation, durable intent, pairing approval and disposal. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNetworkCommand, WorkbenchNetworkConfiguration, WorkbenchNetworkResult, WorkbenchNetworkRuntime } from "workbench-shared/http/workbench-network";
import WorkbenchNetworkController from "./WorkbenchNetworkController.ts";
import ServiceNetworkController from "../../../daemon/host/network/WorkbenchNetworkController.ts";
import type { WorkbenchServiceRegistration, WorkbenchServiceSnapshot } from "workbench-shared/http/workbench-service";

function fixture(privateIssue?: () => string | null) {
  let configuration: WorkbenchNetworkConfiguration = { hostServe: { enabled: false, port: 8080 }, privateAccess: null, members: [] };
  let status!: (runtime: WorkbenchNetworkRuntime) => void;
  const calls: WorkbenchNetworkCommand[] = [];
  let starts = 0;
  let closes = 0;
  let targetAvailable = true;
  let target = { appOrigin: "http://127.0.0.1:4200", daemonOrigin: "http://127.0.0.1:4500", daemonPort: 4500 };
  let result: WorkbenchNetworkResult = { kind: "ok" };
  let rejectedAction: string | null = null;
  let forward = false;
  let beforePortUpdate = async () => {};
  let registration: WorkbenchServiceRegistration | null = null;
  let hostStarted = false;
  const host = new ServiceNetworkController({
    root: ".", stateDirectory: ".", warn: () => {},
    repository: { read: () => structuredClone(configuration), write: next => { configuration = structuredClone(next); } },
    target: () => ({
      ...target, appOrigin: registration?.appOrigin ?? null, ingressToken: registration?.ingressToken,
      privateAppAllowed: registration?.privateAppAllowed ?? true,
    }),
    preview: () => ({ port: registration?.previewHostPort ?? null, retainedPort: registration?.retainedHostPort ?? null }),
    keepPublication: () => false,
    inspect: async () => "test-executable",
    createProcess: options => {
      starts++;
      status = options.status;
      return {
        request: async command => {
          calls.push(command);
          if (command.action === rejectedAction) throw new Error("Injected network operation failure.");
          if (forward && command.action === "configure") status({
            ...host.snapshot().runtime,
            hostServe: { phase: "ready", message: null, url: `http://100.80.0.2:${command.configuration.hostServe.port}` },
          });
          return result;
        },
        close: async () => { closes++; },
        cancelPending: async () => {},
      };
    },
  });
  const snapshot = (): WorkbenchServiceSnapshot => ({
    identity: { protocol: 1, daemonId: "67e323d5-949a-4c41-956f-1fa28905f034", hostname: "fixture", state: "ready", wakeEnabled: false },
    daemonOrigin: target.daemonOrigin, failure: null, network: host.snapshot(), discovery: { refreshing: false, peers: [] },
  });
  const owner = new WorkbenchNetworkController({
    endpointPath: "unused", ensure: async () => {}, wakeLocal: false, warn: () => {}, privateIssue,
    readTarget: () => targetAvailable ? target : null,
    appPort: {
      read: () => ({ appOrigin: target.appOrigin, currentPort: Number(new URL(target.appOrigin).port), editable: true, source: "setting" as const }),
      update: async port => {
        await beforePortUpdate();
        target = { ...target, appOrigin: `http://127.0.0.1:${port}` };
        await owner.targetChanged();
        return { appOrigin: target.appOrigin, currentPort: port, editable: true, source: "setting" as const };
      },
    },
    createClient: () => {
      let ready = false;
      const listeners = new Set<() => void>();
      const emit = () => { for (const listener of listeners) listener(); };
      const unsubscribe = host.subscribe(emit);
      return {
        start: async () => {
          if (!hostStarted) { await host.start(); hostStarted = true; }
          ready = true; emit();
        },
        getSnapshot: () => ({ phase: ready ? "ready" as const : "connecting" as const, snapshot: ready ? snapshot() : null, failure: null }),
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        request: async intent => {
          let result: WorkbenchNetworkResult = { kind: "ok" };
          if (intent.method === "service/app/register") { registration = intent.registration; await host.targetChanged(); }
          else if (intent.method === "service/network/action") result = await host.action(intent.action);
          else if (intent.method === "service/network/settings") result = await host.settings(intent.mode, intent.port);
          emit();
          return { kind: "network-result", id: "fixture", result };
        },
        close: async () => { ready = false; unsubscribe(); registration = null; await host.targetChanged(); },
      };
    },
  });
  return { owner, host, calls, publish: (runtime: WorkbenchNetworkRuntime) => status(runtime),
    get configuration() { return configuration; }, get starts() { return starts; }, get closes() { return closes; },
    target: (port: number) => { target = { ...target, appOrigin: `http://127.0.0.1:${port}` }; },
    result: (next: WorkbenchNetworkResult) => { result = next; },
    fail: (action: string | null) => { rejectedAction = action; },
    seed: (next: WorkbenchNetworkConfiguration) => { configuration = next; },
    targetAvailable: (available: boolean) => { targetAvailable = available; },
    forward: () => { forward = true; },
    portUpdate: (callback: () => Promise<void>) => { beforePortUpdate = callback; },
  };
}

test("a legacy local-port update owns the same mutation boundary as combined settings", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  await f.owner.start();
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.portUpdate(async () => { enter(); await pending; });
  const moving = f.owner.updateLocalPort(4300);
  await entered;
  try {
    assert.equal(f.owner.canChangePort(), false);
    await assert.rejects(f.owner.action({ action: "settings-prepare",
      settings: { mode: "localhost", localPort: 4400, tailnetPort: 8080 },
    }, { deviceNodeId: null, origin: "http://127.0.0.1:4200" }), /current network action/i);
  } finally { finish(); }
  await moving;
  assert.equal(f.owner.snapshot().localPort?.currentPort, 4300);
  assert.equal(f.owner.canChangePort(), true);
});

test("remote settings handoff retains the active entry point until the same device reaches its destination", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  f.seed({
    mode: "tailnet-service", hostServe: { enabled: true, port: 8080 }, members: [],
    privateAccess: { role: "authority", label: "desktop", enabled: true },
  });
  await f.owner.start();
  f.forward();
  const source = { deviceNodeId: "owner-host", origin: "https://desktop.wb.inthedark.boo" };
  const prepared = await f.owner.action({
    action: "settings-prepare", settings: { mode: "tailnet-ip", localPort: 4300, tailnetPort: 8089 },
  }, source);
  assert.equal(prepared.kind, "handoff");
  if (prepared.kind !== "handoff") return;
  assert.equal(prepared.origin, "http://100.80.0.2:8089");
  assert.equal(f.configuration.mode, "tailnet-service");
  assert.equal(f.configuration.hostServe.port, 8080);
  const preview = f.calls.at(-1);
  assert.ok(preview?.action === "configure");
  assert.equal(preview.retainedHostPort, 8080);
  await assert.rejects(f.owner.action({ action: "settings-finish", token: prepared.token }, source), /destination/i);
  await assert.rejects(f.owner.action({ action: "settings-finish", token: prepared.token },
    { deviceNodeId: null, origin: prepared.origin }), /device/i);
  await assert.rejects(f.owner.action({ action: "settings-finish", token: prepared.token }, { ...source, deviceNodeId: "other", origin: prepared.origin }), /device/i);
  const result = await f.owner.action({ action: "settings-finish", token: prepared.token }, { ...source, origin: prepared.origin });
  assert.equal(result.kind, "settings-saved");
  assert.equal(f.configuration.mode, "tailnet-ip");
  assert.equal(f.configuration.hostServe.port, 8089);
  assert.equal(f.owner.snapshot().localPort?.currentPort, 4300);
  assert.equal(f.owner.snapshot().change, null);
  await assert.rejects(f.owner.action({ action: "settings-finish", token: prepared.token }, { ...source, origin: prepared.origin }), /no longer/i);
});

test("the verified host moves to loopback before disabling remote access", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  f.forward();
  await f.owner.start();
  await f.owner.action({ action: "mode", mode: "tailnet-ip" });
  f.publish({ ...f.owner.snapshot().runtime, host: { hostname: "desktop", address: "100.80.0.2", nodeId: "owner-host" } });
  const source = { deviceNodeId: "owner-host", origin: "http://100.80.0.2:8080" };
  const prepared = await f.owner.action({ action: "settings-prepare",
    settings: { mode: "localhost", localPort: 4300, tailnetPort: 8080 },
  }, source);
  assert.ok(prepared.kind === "handoff");
  assert.equal(prepared.origin, "http://127.0.0.1:4200");
  assert.equal(f.configuration.mode, "tailnet-ip");
  await assert.rejects(f.owner.action({ action: "settings-finish", token: prepared.token }, source), /destination/i);
  await assert.rejects(f.owner.action({ action: "settings-finish", token: prepared.token },
    { deviceNodeId: "visitor", origin: prepared.origin }), /device/i);
  const result = await f.owner.action({ action: "settings-finish", token: prepared.token },
    { deviceNodeId: null, origin: prepared.origin });
  assert.deepEqual(result, { kind: "settings-saved", origin: "http://127.0.0.1:4300" });
  assert.equal(f.configuration.mode, "localhost");
  assert.equal(f.owner.snapshot().change, null);
});

test("host access is inherent so saving restrictions needs no handoff or self-grant", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  f.forward();
  await f.owner.start();
  await f.owner.action({ action: "mode", mode: "tailnet-ip" });
  f.publish({ ...f.owner.snapshot().runtime,
    host: { hostname: "desktop", address: "100.80.0.2", nodeId: "owner-host" },
    privateAccess: { ...f.owner.snapshot().runtime.privateAccess, nodeId: "app" },
  });
  const source = { deviceNodeId: "owner-host", origin: "http://100.80.0.2:8080" };
  const policy = { revision: 1, access: "selected" as const, grants: [] };
  for (const action of ["access", "access-prepare"] as const) {
    assert.deepEqual(await f.owner.action({ action, ...policy }, source), { kind: "ok" });
    assert.deepEqual(f.calls.at(-1), { action: "access", ...policy });
    assert.equal(f.owner.snapshot().change, null);
  }
  f.fail("access");
  await assert.rejects(f.owner.action({ action: "access", ...policy }, source), /Injected/);
  assert.equal(f.owner.snapshot().change, null);
  f.fail(null);
  const permitted = { ...policy, grants: [{ deviceNodeId: "other-device", appNodeId: "app" }] };
  assert.deepEqual(await f.owner.action({ action: "access-prepare", ...permitted }, source), { kind: "ok" });
  assert.equal(f.calls.at(-1)?.action, "access");
  await assert.rejects(f.owner.action({ action: "access-prepare", ...policy },
    { ...source, deviceNodeId: "other-device" }), /host|local/i);
});

test("remote localhost selection is rejected before any configuration or forwarding mutation", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  await f.owner.start();
  await f.owner.action({ action: "mode", mode: "tailnet-ip" });
  const before = structuredClone(f.configuration);
  const calls = f.calls.length;
  await assert.rejects(f.owner.action({
    action: "settings-prepare", settings: { mode: "localhost", localPort: 4300, tailnetPort: 8080 },
  }, { deviceNodeId: "owner-host", origin: "http://100.80.0.2:8080" }), /local/i);
  assert.deepEqual(f.configuration, before);
  assert.equal(f.calls.length, calls);
});

test("a replacement forwarding failure preserves committed settings", async context => {
  const f = fixture();
  context.after(() => { f.fail(null); return f.owner.close(); });
  f.forward();
  await f.owner.start();
  await f.owner.action({ action: "mode", mode: "tailnet-ip" });
  const before = structuredClone(f.configuration);
  f.fail("configure");
  await assert.rejects(f.owner.action({ action: "settings-prepare",
    settings: { mode: "tailnet-ip", localPort: 4200, tailnetPort: 8089 },
  }, { deviceNodeId: null, origin: "http://127.0.0.1:4200" }), /failure/i);
  assert.deepEqual(f.configuration, before);
  assert.equal(f.owner.snapshot().change, null);
});

test("a local move followed by failure returns the surviving address for explicit retry", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  f.forward();
  await f.owner.start();
  await f.owner.action({ action: "mode", mode: "tailnet-ip" });
  const caller = { deviceNodeId: null, origin: "http://127.0.0.1:4200" };
  const prepared = await f.owner.action({ action: "settings-prepare",
    settings: { mode: "tailnet-ip", localPort: 4300, tailnetPort: 8080 },
  }, caller);
  assert.equal(prepared.kind, "handoff");
  if (prepared.kind !== "handoff") return;
  f.fail("configure");
  const result = await f.owner.action({ action: "settings-finish", token: prepared.token }, caller);
  assert.equal(result.kind, "settings-pending");
  assert.ok("origin" in result);
  assert.equal(result.origin, "http://127.0.0.1:4300");
  assert.equal(f.owner.snapshot().change?.phase, "failed");
  f.fail(null);
  await f.owner.action({ action: "settings-finish", token: prepared.token }, { ...caller, origin: result.origin });
  assert.equal(f.owner.snapshot().change, null);
});

test("cancelling a prepared port handoff returns before removing temporary forwarding; reload retires its receipt", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  f.forward();
  await f.owner.start();
  await f.owner.action({ action: "mode", mode: "tailnet-ip" });
  const source = { deviceNodeId: "owner-host", origin: "http://100.80.0.2:8080" };
  const prepared = await f.owner.action({ action: "settings-prepare", settings: { mode: "tailnet-ip", localPort: 4200, tailnetPort: 8089 } }, source);
  assert.equal(prepared.kind, "handoff");
  if (prepared.kind !== "handoff") return;
  const returning = await f.owner.action({ action: "settings-cancel", token: prepared.token }, { ...source, origin: prepared.origin });
  assert.equal(returning.kind, "handoff");
  if (returning.kind !== "handoff") return;
  assert.equal(returning.origin, source.origin);
  assert.notEqual(f.owner.snapshot().change, null);
  await f.owner.action({ action: "settings-cancel", token: prepared.token }, source);
  assert.equal(f.owner.snapshot().change, null);
  assert.equal(f.configuration.hostServe.port, 8080);
  const next = await f.owner.action({ action: "settings-prepare", settings: { mode: "tailnet-ip", localPort: 4200, tailnetPort: 8090 } }, source);
  assert.equal(next.kind, "handoff");
  if (next.kind !== "handoff") return;
  await assert.rejects(f.owner.action({ action: "settings-resume" }, { ...source, deviceNodeId: "other" }), /device/i);
  const resumed = await f.owner.action({ action: "settings-resume" }, source);
  assert.equal(resumed.kind, "handoff");
  assert.ok("token" in resumed);
  assert.equal(resumed.token, next.token);
  await f.owner.suspend();
  await f.owner.start();
  assert.equal(f.owner.snapshot().change, null);
  const restored = f.calls.at(-1);
  assert.ok(restored?.action === "configure");
  assert.equal(restored.configuration.hostServe.port, 8080);
  assert.equal(restored.retainedHostPort, undefined);
  await assert.rejects(f.owner.action({ action: "settings-finish", token: next.token }, source), /no longer/i);
});

test("persisted owner can manage its network while disconnected but a member cannot", async context => {
  for (const role of ["authority", "member"] as const) {
    const f = fixture();
    context.after(() => f.owner.close());
    f.seed({
      mode: "localhost", hostServe: { enabled: false, port: 8080 },
      privateAccess: role === "authority"
        ? { role, label: "desktop", enabled: false }
        : { role, label: "laptop", enabled: false, issuer: { address: "100.80.0.1", hostname: "desktop.wb.inthedark.boo" } },
      members: [{ nodeId: "desktop", label: "desktop", addresses: ["100.80.0.1"], keyFingerprint: "a".repeat(64) }],
      group: { id: "67e323d5-949a-4c41-956f-1fa28905f034", revision: 1, ownerNodeId: "desktop", dnsNodeId: "desktop", access: "all", grants: [] },
    });
    await f.owner.start();
    assert.equal(f.owner.ingress({})?.manageNetwork, role === "authority");
  }
});

test("disabled defaults spawn nothing; independent modes follow port changes and close when disabled", async () => {
  const f = fixture();
  await f.owner.start();
  assert.equal(f.starts, 0);
  await f.owner.action({ action: "host-serve", enabled: true, port: 8088 });
  assert.equal(f.starts, 1);
  assert.equal(f.configuration.privateAccess, null);
  f.target(4300);
  await f.owner.targetChanged();
  const latest = f.calls.at(-1);
  assert.equal(latest?.action, "configure");
  if (latest?.action === "configure") assert.equal(latest.appOrigin, "http://127.0.0.1:4300");
  await f.owner.action({ action: "host-serve", enabled: false, port: 8088 });
  assert.equal(f.closes, 1);
  await f.owner.close();
});

test("authenticated app access does not grant network management and retired ingress credentials fail closed", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  f.seed({
    mode: "tailnet-ip", hostServe: { enabled: true, port: 8080 },
    privateAccess: { role: "authority", label: "desktop", enabled: false },
    members: [{ nodeId: "desktop", hostNodeId: "owner-host", label: "desktop", addresses: ["100.80.0.1"], keyFingerprint: "a".repeat(64) }],
    group: { id: "67e323d5-949a-4c41-956f-1fa28905f034", revision: 1, ownerNodeId: "desktop", dnsNodeId: "desktop", access: "all", grants: [] },
  });
  await f.owner.start();
  const configure = f.calls.findLast(command => command.action === "configure");
  assert.ok(configure?.action === "configure" && configure.ingressToken);
  const headers = { "x-workbench-network-token": configure.ingressToken, "x-workbench-network-device": "visitor" };
  assert.deepEqual(f.owner.ingress(headers), { deviceNodeId: "visitor", manageApp: false, manageNetwork: false, trustHost: false });
  const ownerHeaders = { ...headers, "x-workbench-network-device": "owner-host" };
  assert.equal(f.owner.ingress(ownerHeaders)?.manageNetwork, true);
  assert.equal(f.owner.ingress(ownerHeaders)?.trustHost, false, "network ownership does not prove this is the app host");
  f.publish({ ...f.owner.snapshot().runtime, host: { hostname: "desktop", address: "100.80.0.2", nodeId: "owner-host" } });
  assert.equal(f.owner.ingress(ownerHeaders)?.trustHost, true);
  assert.equal(f.owner.ingress({})?.trustHost, true);
  assert.equal(f.owner.ingress({ ...ownerHeaders, "x-workbench-network-token": "0".repeat(64) }), null);
  await f.owner.suspend();
  assert.equal(f.owner.ingress(ownerHeaders), null, "a detached app session loses ingress authority immediately");
  await f.owner.start();
  assert.equal(f.owner.ingress(ownerHeaders), null, "a previous app session's credentials must not survive replacement");
  assert.equal(f.owner.ingress({})?.manageNetwork, true, "local owner access remains available");
});

test("localhost closes its helper even when the final disabled configuration is rejected", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  await f.owner.start();
  await f.owner.action({ action: "mode", mode: "tailnet-ip" });
  f.fail("configure");
  await assert.rejects(f.owner.action({ action: "mode", mode: "localhost" }), /Injected/);
  assert.equal(f.configuration.mode, "localhost");
  assert.equal(f.closes, 1);
});

test("service selection includes host forwarding and localhost stops both without losing the selected tailnet port", async () => {
  const f = fixture();
  f.seed({
    hostServe: { enabled: false, port: 8080 }, members: [],
    privateAccess: { role: "authority", label: "desktop", enabled: false, nodeLabel: "original" },
  });
  await f.owner.start();
  try {
    await f.owner.action({ action: "tailnet-port", port: 8088 });
    assert.equal(f.starts, 0);
    await f.owner.action({ action: "mode", mode: "tailnet-service" });
    assert.equal(f.configuration.hostServe.enabled, true);
    assert.equal(f.configuration.mode, "tailnet-service");
    const privateAccess = structuredClone(f.configuration.privateAccess);
    await f.owner.action({ action: "tailnet-port", port: 8089 });
    assert.equal(f.configuration.mode, "tailnet-service");
    assert.equal(f.configuration.hostServe.port, 8089);
    assert.deepEqual(f.configuration.privateAccess, privateAccess);
    const configured = f.calls.at(-1);
    assert.equal(configured?.action, "configure");
    if (configured?.action === "configure") {
      assert.equal(configured.configuration.hostServe.port, 8089);
      assert.equal(configured.configuration.privateAccess?.enabled, true);
    }
    await f.owner.action({ action: "mode", mode: "localhost" });
    assert.equal(f.configuration.hostServe.enabled, false);
    assert.equal(f.configuration.hostServe.port, 8089);
    assert.equal(f.closes, 1);
    await assert.rejects(f.owner.action({ action: "tailnet-port", port: 52739 }), /daemon/i);
  } finally { await f.owner.close(); }
});

test("URL rename commits after activation while retaining the installation's internal node label", async () => {
  const f = fixture();
  await f.owner.start();
  try {
    await f.owner.action({ action: "prepare", label: "desktop" });
    f.result({ kind: "setup", privateAccess: { role: "authority", label: "desktop", enabled: false }, members: [] });
    await f.owner.action({ action: "create-setup", clientId: "id", clientSecret: "secret" });
    f.result({ kind: "ok" });
    await f.owner.action({ action: "machine-name", label: "desk" });
    assert.equal(f.configuration.privateAccess?.label, "desk");
    assert.equal(f.configuration.privateAccess?.nodeLabel, "desktop");
    assert.equal(f.configuration.rename, undefined);
    assert.deepEqual(f.calls.filter(command => command.action.startsWith("rename-")).map(command => command.action),
      ["rename-prepare", "rename-activate", "rename-retire"]);
  } finally { await f.owner.close(); }
});

test("failed URL transitions retain their phase and retry without re-pairing or reporting a premature address change", async () => {
  for (const action of ["rename-prepare", "rename-activate", "rename-retire"] as const) {
    const f = fixture();
    await f.owner.start();
    try {
      await f.owner.action({ action: "prepare", label: "desktop" });
      f.result({ kind: "setup", privateAccess: { role: "authority", label: "desktop", enabled: false }, members: [] });
      await f.owner.action({ action: "create-setup", clientId: "id", clientSecret: "secret" });
      f.result({ kind: "ok" });
      f.fail(action);
      await assert.rejects(f.owner.action({ action: "machine-name", label: "desk" }), /Injected/);
      assert.equal(f.configuration.rename?.phase, action.slice("rename-".length));
      assert.equal(f.configuration.privateAccess?.label, action === "rename-retire" ? "desk" : "desktop");
      assert.ok(f.owner.snapshot().failure);
      await assert.rejects(f.owner.action({ action: "machine-name", label: "third" }), /pending/);
      await assert.rejects(f.owner.action({ action: "remove-registration" }), /rename/iu);
      await assert.rejects(f.owner.action({ action: "remove-registration" }), /rename/iu);
      const offset = f.calls.length;
      f.fail(null);
      await f.owner.action({ action: "retry" });
      assert.equal(f.configuration.rename, undefined);
      assert.equal(f.configuration.privateAccess?.label, "desk");
      assert.equal(f.configuration.privateAccess?.nodeLabel, "desktop");
      assert.equal(f.calls.slice(offset).filter(command => command.action.startsWith("rename-"))[0]?.action, action);
    } finally { await f.owner.close(); }
  }
});

test("localhost suspends a pending rename until service mode is selected again", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  await f.owner.start();
  await f.owner.action({ action: "prepare", label: "desktop" });
  f.fail("rename-prepare");
  await assert.rejects(f.owner.action({ action: "machine-name", label: "desk" }), /Injected/);
  await f.owner.action({ action: "mode", mode: "localhost" });
  assert.equal(f.closes, 1);
  assert.ok(f.configuration.rename);
  await f.owner.suspend();
  f.fail(null);
  await f.owner.start();
  assert.equal(f.starts, 1, "localhost restart must not resume private networking");
  await f.owner.action({ action: "mode", mode: "tailnet-service" });
  assert.equal(f.configuration.rename, undefined);
  assert.equal(f.configuration.privateAccess?.label, "desk");
});

test("the independent service resumes a rename without an app listener", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  f.seed({
    mode: "tailnet-service", hostServe: { enabled: true, port: 8080 },
    privateAccess: { role: "authority", enabled: true, label: "desktop", nodeLabel: "desktop" }, members: [],
    rename: { id: "6e1a6f64-af71-4639-b997-65d8f314b352", from: "desktop", to: "desk", phase: "prepare" },
  });
  f.targetAvailable(false);
  await f.owner.start();
  assert.equal(f.starts, 1);
  assert.equal(f.configuration.rename, undefined);
  assert.equal(f.owner.snapshot().busy, false);
  f.targetAvailable(true);
  await f.owner.targetChanged();
  assert.equal(f.configuration.rename, undefined);
  assert.equal(f.configuration.privateAccess?.label, "desk");
  assert.equal(f.owner.snapshot().failure, null);
});

test("setup results persist before activation; permanent labels and incomplete enablement are rejected", async () => {
  const f = fixture();
  await f.owner.start();
  await assert.rejects(f.owner.action({ action: "private-access", enabled: true }));
  await f.owner.action({ action: "prepare", label: "desktop" });
  await assert.rejects(f.owner.action({ action: "prepare", label: "other" }));
  await assert.rejects(f.owner.action({ action: "private-access", enabled: true }));
  f.result({ kind: "setup", privateAccess: { role: "authority", label: "desktop", enabled: false }, members: [] });
  await f.owner.action({ action: "create-setup", clientId: "id", clientSecret: "SECRET" });
  assert.equal(f.configuration.privateAccess?.role, "authority");
  assert.equal(f.configuration.privateAccess?.enabled, false);
  assert.ok(!JSON.stringify(f.owner.snapshot()).includes("SECRET"));
  await f.owner.close();
});

test("approval persists the exact pending identity before releasing certificate issuance", async () => {
  const f = fixture();
  await f.owner.start();
  await f.owner.action({ action: "prepare", label: "desktop" });
  f.result({ kind: "setup", privateAccess: { role: "authority", label: "desktop", enabled: false }, members: [] });
  await f.owner.action({ action: "create-setup", clientId: "id", clientSecret: "secret" });
  f.result({ kind: "ok" });
  const member = { nodeId: "peer", label: "laptop", keyFingerprint: "a".repeat(64), addresses: ["100.64.1.2"] };
  const runtime = f.owner.snapshot().runtime;
  f.publish({ ...runtime, privateAccess: { ...runtime.privateAccess, pending: [{ id: "request", member }] } });
  await f.owner.action({ action: "approve", requestId: "request", approved: true });
  assert.deepEqual(f.configuration.members, [member]);
  assert.deepEqual(f.calls.at(-1), { action: "approve-member", requestId: "request", member });
  await assert.rejects(f.owner.action({ action: "approve", requestId: "missing", approved: true }));
  await f.owner.close();
});

test("app reload detaches its session without stopping independent networking", async () => {
  const f = fixture();
  await f.owner.start();
  await f.owner.action({ action: "host-serve", enabled: true, port: 8088 });
  await f.owner.suspend();
  assert.equal(f.closes, 0);
  await assert.rejects(f.owner.action({ action: "host-serve", enabled: false, port: 8088 }));
  await f.owner.start();
  assert.equal(f.starts, 1);
  assert.equal(f.configuration.hostServe.enabled, true);
  await f.owner.close();
});

test("incompatible private HTTPS configuration is reported without preventing the independent static mode", async () => {
  const f = fixture(() => "Insecure explicit daemon URL.");
  await f.owner.start();
  await f.owner.action({ action: "host-serve", enabled: true, port: 8088 });
  assert.equal(f.configuration.hostServe.enabled, true);
  await assert.rejects(f.owner.action({ action: "prepare", label: "desktop" }), /Insecure/u);
  assert.equal(f.configuration.privateAccess, null);
  assert.equal(f.configuration.hostServe.enabled, true);
  await f.owner.close();
});

test("an incompatible persisted service mode cannot override the private HTTPS safety rejection", async () => {
  const f = fixture(() => "Insecure explicit daemon URL.");
  f.seed({
    mode: "tailnet-service", hostServe: { enabled: true, port: 8080 },
    privateAccess: { role: "authority", enabled: true, label: "desktop" }, members: [],
  });
  try {
    await f.owner.start();
    const configure = f.calls.findLast(command => command.action === "configure");
    assert.equal(configure?.action, "configure");
    if (configure?.action === "configure") {
      assert.equal(configure.privateAppAllowed, false);
      assert.equal(configure.configuration.mode, "tailnet-service", "app safety must not disable the independent network identity");
    }
    assert.equal(f.configuration.mode, "tailnet-service", "runtime safety must not rewrite the user's desired mode");
  } finally { await f.owner.close(); }
});
