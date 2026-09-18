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
  const routes = new WorkbenchNetworkRoutes({
    connection: () => ({ localPort: null, tailnetPort: 52739 }),
    snapshot: () => ({ configuration: { privateAccess: null } }) as WorkbenchNetworkSnapshot,
    subscribe: () => () => {},
    action: async () => { calls++; enter(); return await pending; },
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
  const rejected = await fetch(`${origin}/api/workbench-network`, {
    method: "POST", headers: { Origin: "https://outside.example", "Content-Type": "application/json", "X-Workbench-Network-Request": "1" },
    body: JSON.stringify({ action: "pair-code" }),
  });
  assert.equal(rejected.status, 403);
  assert.equal(calls, 0);
  await returned;
  let actionHandled!: () => void;
  const actionReturned = new Promise<void>(resolve => { actionHandled = resolve; });
  handled = actionHandled;
  const response = fetch(`${origin}/api/workbench-network`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Workbench-Network-Request": "1" },
    body: JSON.stringify({ action: "pair-code" }),
  });
  await entered;
  await actionReturned;
  routes.close();
  assert.equal((await response).status, 503);
});
