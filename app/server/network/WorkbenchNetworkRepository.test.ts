/* No production exports. Protect mode intent, stable identity and atomic private membership storage. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchAppStateRepository from "../state/WorkbenchAppStateRepository.ts";
import WorkbenchNetworkRepository from "./WorkbenchNetworkRepository.ts";
import { WorkbenchNetworkConfigurationSchema, type WorkbenchNetworkConfiguration } from "workbench-shared/http/workbench-network";

test("persists network state without changing browser revisions and refuses partial membership writes", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wb-network-state-"));
  const database = new WorkbenchAppStateRepository({ dataRootPath: root });
  await database.start();
  context.after(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  const network = new WorkbenchNetworkRepository(database);
  const defaults = network.read();
  assert.equal(defaults.hostServe.enabled, false);
  assert.equal(defaults.privateAccess, null);
  const browserVersion = database.currentVersion();
  const configuration: WorkbenchNetworkConfiguration = {
    mode: "tailnet-ip",
    hostServe: { enabled: true, port: 8088 },
    privateAccess: { enabled: false, label: "desktop", nodeLabel: "desktop", role: "member", issuer: { address: "100.80.0.1", hostname: "nas.wb.inthedark.boo" } },
    members: [{ nodeId: "node-a", label: "laptop", keyFingerprint: "a".repeat(64), addresses: ["100.80.0.2", "fd7a:115c:a1e0::2"] }],
  };
  network.write(configuration);
  assert.deepEqual(new WorkbenchNetworkRepository(database).read(), configuration);
  assert.deepEqual(database.currentVersion(), browserVersion);
  assert.throws(() => network.write({ ...configuration, members: [...configuration.members, { ...configuration.members[0]!, nodeId: "node-b" }] }));
  assert.deepEqual(network.read(), configuration);
  assert.throws(() => network.write({ ...configuration, privateAccess: { enabled: false, role: "unconfigured", label: "renamed" } }));
  assert.deepEqual(network.read(), configuration);
});

test("one selected mode determines exposure and a pending URL rename preserves the stable node name", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wb-network-mode-"));
  const database = new WorkbenchAppStateRepository({ dataRootPath: root });
  await database.start();
  context.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
  const network = new WorkbenchNetworkRepository(database);
  const selected = WorkbenchNetworkConfigurationSchema.parse({
    ...network.read(), mode: "tailnet-service",
    privateAccess: { role: "authority", enabled: false, label: "desktop", nodeLabel: "original" },
  });
  network.write(selected);
  const reopened = new WorkbenchNetworkRepository(database).read();
  assert.equal(reopened.hostServe.enabled, true);
  assert.equal(reopened.privateAccess?.enabled, true);
  const pending = WorkbenchNetworkConfigurationSchema.parse({
    ...reopened,
    rename: { id: "e320717d-4c37-49d1-8d4f-8eeab5045a8d", from: "desktop", to: "desk", phase: "prepare" },
  });
  network.write(pending);
  assert.deepEqual(network.read(), pending);
  assert.throws(() => network.write(reopened), /rename/iu);
  assert.deepEqual(network.read(), pending);
  const member = { nodeId: "node-a", label: "laptop", keyFingerprint: "a".repeat(64), addresses: ["100.80.0.2"] };
  const reservation = { id: "efbbcb3d-cbdc-4286-ac7e-c794196a9eee", from: "laptop", to: "portable" };
  network.write({ ...pending, members: [{ ...member, rename: reservation }] });
  assert.throws(() => network.write({ ...pending, members: [member] }), /rename/iu);
  assert.equal(network.read().members[0]?.rename?.to, "portable");
  network.write({ ...pending, members: [{ ...member, label: "portable" }] });
  assert.equal(network.read().members[0]?.rename, undefined);
});
