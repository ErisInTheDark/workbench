/* No production exports. Protect optional-mode isolation, durable intent, pairing approval and disposal. */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchNetworkCommand, WorkbenchNetworkConfiguration, WorkbenchNetworkResult, WorkbenchNetworkRuntime } from "workbench-shared/http/workbench-network";
import WorkbenchNetworkController from "./WorkbenchNetworkController.ts";

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
  const owner = new WorkbenchNetworkController({
    root: ".", stateDirectory: ".", warn: () => {}, privateIssue,
    repository: { read: () => structuredClone(configuration), write: next => { configuration = structuredClone(next); } },
    readTarget: () => targetAvailable ? target : null, inspect: async () => "test-executable",
    createProcess: publish => {
      starts++;
      status = publish;
      return {
        request: async command => {
          calls.push(command);
          if (command.action === rejectedAction) throw new Error("Injected network operation failure.");
          return result;
        },
        close: async () => { closes++; },
        cancelPending: async () => {},
      };
    },
  });
  return { owner, calls, publish: (runtime: WorkbenchNetworkRuntime) => status(runtime),
    get configuration() { return configuration; }, get starts() { return starts; }, get closes() { return closes; },
    target: (port: number) => { target = { ...target, appOrigin: `http://127.0.0.1:${port}` }; },
    result: (next: WorkbenchNetworkResult) => { result = next; },
    fail: (action: string | null) => { rejectedAction = action; },
    seed: (next: WorkbenchNetworkConfiguration) => { configuration = next; },
    targetAvailable: (available: boolean) => { targetAvailable = available; },
  };
}

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
  await f.owner.start();
  try {
    await f.owner.action({ action: "tailnet-port", port: 8088 });
    assert.equal(f.starts, 0);
    await f.owner.action({ action: "mode", mode: "tailnet-service" });
    assert.equal(f.configuration.hostServe.enabled, true);
    assert.equal(f.configuration.mode, "tailnet-service");
    await f.owner.action({ action: "mode", mode: "localhost" });
    assert.equal(f.configuration.hostServe.enabled, false);
    assert.equal(f.configuration.hostServe.port, 8088);
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
      await assert.rejects(f.owner.action({ action: "restore", password: "long backup password", backup: "backup" }), /rename/iu);
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

test("startup resumes a service rename only after the app listener is available", async context => {
  const f = fixture();
  context.after(() => f.owner.close());
  f.seed({
    mode: "tailnet-service", hostServe: { enabled: true, port: 8080 },
    privateAccess: { role: "authority", enabled: true, label: "desktop", nodeLabel: "desktop" }, members: [],
    rename: { id: "6e1a6f64-af71-4639-b997-65d8f314b352", from: "desktop", to: "desk", phase: "prepare" },
  });
  f.targetAvailable(false);
  await f.owner.start();
  assert.equal(f.starts, 0);
  assert.equal(f.owner.snapshot().busy, false, "no rename operation starts before listener publication");
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

test("reload suspension releases the sidecar before a replacement and can resume durable intent", async () => {
  const f = fixture();
  await f.owner.start();
  await f.owner.action({ action: "host-serve", enabled: true, port: 8088 });
  await f.owner.suspend();
  assert.equal(f.closes, 1);
  await assert.rejects(f.owner.action({ action: "host-serve", enabled: false, port: 8088 }));
  await f.owner.start();
  assert.equal(f.starts, 2);
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
    const configure = f.calls.find(command => command.action === "configure");
    assert.equal(configure?.action, "configure");
    if (configure?.action === "configure") {
      assert.equal(configure.configuration.mode, "tailnet-ip");
      assert.equal(configure.configuration.privateAccess?.enabled, false);
    }
    assert.equal(f.configuration.mode, "tailnet-service", "runtime safety must not rewrite the user's desired mode");
  } finally { await f.owner.close(); }
});
