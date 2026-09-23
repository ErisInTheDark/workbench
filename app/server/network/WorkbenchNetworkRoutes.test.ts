/* No production exports. Protect same-origin mutation admission and reload disposal without waiting for pairing. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { WorkbenchNetworkResult, WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import WorkbenchNetworkRoutes from "./WorkbenchNetworkRoutes.ts";

test("cross-origin actions are rejected; admitted actions do not pin route disposal", async context => {
  let finish!: (result: WorkbenchNetworkResult) => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<WorkbenchNetworkResult>(resolve => { finish = resolve; });
  let calls = 0;
  let trustHost = false;
  let manageNetwork = true;
  let deviceNodeId: string | null = null;
  const routes = new WorkbenchNetworkRoutes({
    ingress: () => ({ deviceNodeId, manageApp: true, manageNetwork, trustHost }),
    discovery: () => ({ refreshing: false, peers: [{
      phase: "verified", peerId: "peer", hostname: "peer",
      identity: { protocol: 1, daemonId: "063e3626-50f7-4635-950e-cdff695d0bc1",
        hostname: "peer", state: "sleeping", wakeEnabled: true },
      origin: "http://100.64.1.2:52739",
      endpoints: { httpOrigin: "http://100.64.1.2:52739", secureOrigin: "https://peer.wb.inthedark.boo:52739" },
    }] }),
    connection: () => ({ localPort: null, tailnetPort: 52739 }),
    snapshot: () => ({ configuration: { privateAccess: null } }) as WorkbenchNetworkSnapshot,
    subscribe: () => () => {},
    action: async () => { calls++; if (!trustHost) return { kind: "ok" }; enter(); return await pending; },
  });
  let handled!: () => void;
  const returned = new Promise<void>(resolve => { handled = resolve; });
  const server = createServer((request, response) => {
    void routes.handle(request, response, new URL(request.url!, "http://localhost")).then(found => {
      if (!found) { response.writeHead(404); response.end(); }
      handled();
    });
  });
  context.after(async () => {
    finish({ kind: "ok" });
    routes.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const legacy = await (await fetch(`${origin}/api/workbench-network`)).json();
  assert.deepEqual(legacy.capabilities, { manageApp: true, manageNetwork: true });
  const current = await (await fetch(`${origin}/api/workbench-network?capabilities=2`)).json();
  assert.deepEqual(current.capabilities, { manageApp: true, manageNetwork: true, trustHost: false });
  deviceNodeId = "remote-owner";
  const remote = await (await fetch(`${origin}/api/workbench-network?capabilities=3`)).json();
  assert.equal(remote.capabilities.localConnection, false);
  assert.equal(remote.capabilities.settingsApply, true);
  const compatible = await (await fetch(`${origin}/api/workbench-network?capabilities=4`)).json();
  assert.equal("endpoints" in compatible.discovery.peers[0], false);
  const modern = await (await fetch(`${origin}/api/workbench-network?capabilities=5`)).json();
  assert.equal(modern.discovery.peers[0].endpoints.secureOrigin, "https://peer.wb.inthedark.boo:52739");
  for (const action of [{ action: "mode", mode: "localhost" }, { action: "tailnet-port", port: 8089 }, { action: "private-access", enabled: false }]) {
    const unsafe = await fetch(`${origin}/api/workbench-network`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Workbench-Network-Request": "1" },
      body: JSON.stringify(action),
    });
    assert.equal(unsafe.status, 409);
  }
  assert.equal(calls, 0);
  manageNetwork = false;
  const forbiddenAccess = await fetch(`${origin}/api/workbench-network`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Workbench-Network-Request": "1" },
    body: JSON.stringify({ action: "access-prepare", revision: 1, access: "selected", grants: [] }),
  });
  assert.equal(forbiddenAccess.status, 403);
  assert.equal(calls, 0, "managing one app does not authorise changing network grants");
  manageNetwork = true;
  const forwarded = await fetch(`${origin}/api/workbench-network`, {
    method: "POST", headers: { Origin: "http://100.80.0.2:8080", "Content-Type": "application/json",
      "X-Workbench-Network-Request": "1", "X-Workbench-Network-Origin": "http://100.80.0.2:8080" },
    body: JSON.stringify({ action: "settings-resume" }),
  });
  assert.equal(forwarded.status, 200, "trusted proxy origin survives rewriting Host to the local target");
  assert.equal(calls, 1);
  calls = 0;
  deviceNodeId = null;
  const rejected = await fetch(`${origin}/api/workbench-network`, {
    method: "POST", headers: { Origin: "https://outside.example", "Content-Type": "application/json", "X-Workbench-Network-Request": "1" },
    body: JSON.stringify({ action: "pair-code" }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(calls, 0);
  const remoteTrust = await fetch(`${origin}/api/workbench-network`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Workbench-Network-Request": "1" },
    body: JSON.stringify({ action: "trust-host" }),
  });
  assert.equal(remoteTrust.status, 403);
  assert.equal(calls, 0);
  trustHost = true;
  deviceNodeId = "host-through-tailnet";
  const host = await (await fetch(`${origin}/api/workbench-network?capabilities=3`)).json();
  assert.equal(host.capabilities.trustHost, true);
  assert.equal(host.capabilities.localConnection, false, "host identity is independent of transport");
  deviceNodeId = null;
  await returned;
  let actionHandled!: () => void;
  const actionReturned = new Promise<void>(resolve => { actionHandled = resolve; });
  handled = actionHandled;
  const response = fetch(`${origin}/api/workbench-network`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Workbench-Network-Request": "1" },
    body: JSON.stringify({ action: "trust-host" }),
  });
  await entered;
  await actionReturned;
  routes.close();
  assert.equal((await response).status, 503);
});
