/* No exports. Protect same-origin handoff admission, grants and nonblocking route retirement. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { WorkbenchNetworkResult } from "workbench-shared/http/workbench-network";
import WorkbenchNetworkRoutes from "./WorkbenchNetworkRoutes";

test("handoffs require authenticated same-origin grants and cannot pin route disposal", async context => {
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<WorkbenchNetworkResult>();
  let calls = 0;
  let authenticated = true;
  let trustHost = false;
  let manageNetwork = true;
  let deviceNodeId: string | null = null;
  const routes = new WorkbenchNetworkRoutes({
    ingress: () => authenticated ? { deviceNodeId, manageApp: true, manageNetwork, trustHost } : null,
    discovery: () => ({ refreshing: false, peers: [] }),
    getFacts: () => ({ phase: "current", failure: null, generation: 1, snapshot: null }),
    subscribe: () => () => {},
    action: async () => {
      calls++;
      if (!trustHost) return { kind: "ok" };
      entered.resolve();
      return await pending.promise;
    },
  });
  const server = createServer((request, response) => {
    void routes.handle(request, response, new URL(request.url!, "http://localhost")).then(found => {
      if (!found) { response.writeHead(404); response.end(); }
    });
  });
  context.after(async () => {
    pending.resolve({ kind: "ok" });
    routes.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (action: object, headers: Record<string, string> = {}) => fetch(`${origin}/api/workbench-network`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json",
      "X-Workbench-Network-Request": "1", ...headers }, body: JSON.stringify(action),
  });
  assert.equal((await post({ action: "settings-resume" }, { Origin: "https://outside.example" })).status, 403);
  authenticated = false;
  assert.equal((await post({ action: "settings-resume" })).status, 403);
  authenticated = true;
  manageNetwork = false;
  assert.equal((await post({ action: "access-prepare", revision: 1, access: "selected", grants: [] })).status, 403);
  assert.equal(calls, 0);
  manageNetwork = true;
  deviceNodeId = "remote-owner";
  for (const action of [{ action: "mode", mode: "localhost" }, { action: "tailnet-port", port: 8089 },
    { action: "private-access", enabled: false }]) {
    assert.equal((await post(action)).status, 409);
  }
  assert.equal((await post({ action: "settings-resume" }, { Origin: "http://100.80.0.2:8080",
    "X-Workbench-Network-Origin": "http://100.80.0.2:8080" })).status, 200);
  assert.equal(calls, 1);
  assert.equal((await post({ action: "trust-host" })).status, 403);
  trustHost = true;
  const response = post({ action: "trust-host" });
  await entered.promise;
  routes.close();
  assert.equal((await response).status, 503);
});
