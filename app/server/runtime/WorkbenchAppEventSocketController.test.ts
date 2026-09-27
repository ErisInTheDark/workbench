/* No production exports. Protect app event socket admission, current state and revocation. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import type { WorkbenchNetworkSnapshot } from "workbench-shared/http/workbench-network";
import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import WorkbenchNetworkRoutes from "../network/WorkbenchNetworkRoutes.ts";
import type WorkbenchBrowserStateRegistry from "../state/WorkbenchBrowserStateRegistry.ts";
import WorkbenchAppEventSocketController from "./WorkbenchAppEventSocketController.ts";

test("network sockets deliver current state and close when their grant disappears", async context => {
  let granted = true;
  let notify = () => {};
  let unsubscribed = 0;
  const lines: string[] = [];
  const network = {
    ingress: () => granted ? { deviceNodeId: null, manageApp: true, manageNetwork: true, trustHost: false } : null,
    discovery: () => ({ refreshing: false, peers: [] }),
    connection: () => ({ localPort: null, tailnetPort: 0 }),
    snapshot: () => ({ configuration: { privateAccess: null } }) as WorkbenchNetworkSnapshot,
    subscribe: (listener: () => void) => { notify = listener; return () => { notify = () => {}; unsubscribed++; }; },
    action: async () => ({ kind: "ok" as const }),
  };
  const routes = new WorkbenchNetworkRoutes(network, undefined, undefined, true);
  let sendStateNotice = (_revision: number) => {};
  const state = {
    readBrowser: async () => ({ kind: "snapshot", revision: 5, rows: {} }),
    subscribeBrowser: (_browserStateId: string | undefined, listener: (revision: number) => void) => {
      sendStateNotice = listener;
      return () => { sendStateNotice = () => {}; };
    },
  } as unknown as WorkbenchBrowserStateRegistry;
  const sockets = new WorkbenchAppEventSocketController({
    logger: new WorkbenchProcessLogger({
      color: false, writeOutput: line => lines.push(line), writeError: line => lines.push(line),
    }),
    network, routes, state,
  });
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head));
  context.after(async () => {
    sockets.close();
    routes.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = new WebSocket(`${origin.replace(/^http/u, "ws")}/api/workbench-network/socket?capabilities=6`, { origin });
  context.after(() => client.terminate());
  const [message] = await once(client, "message");
  const frame = JSON.parse(message.toString()) as { kind: string; snapshot: { capabilities: { appEventsWebSocket: boolean } } };
  assert.equal(frame.kind, "network");
  assert.equal(frame.snapshot.capabilities.appEventsWebSocket, true);
  client.send(JSON.stringify({ id: 1, method: "app/network/read", params: {} }));
  const [reply] = await Promise.race([
    once(client, "message"),
    once(client, "close").then(() => { throw new Error("RPC socket closed before replying."); }),
  ]);
  const response = JSON.parse(reply.toString()) as { id: number; result: { capabilities: { appEventsWebSocket: boolean } } };
  assert.equal(response.id, 1);
  assert.equal(response.result.capabilities.appEventsWebSocket, true);
  client.send(JSON.stringify({ id: 2, method: "app/state/read",
    params: { browserStateId: null, sinceRevision: null } }));
  const [stateReply] = await once(client, "message");
  assert.deepEqual(JSON.parse(stateReply.toString()), {
    id: 2, result: { kind: "snapshot", revision: 5, rows: {} },
  });
  const notice = once(client, "message");
  sendStateNotice(6);
  assert.deepEqual(JSON.parse((await notice)[0].toString()), { kind: "state", revision: 6 });
  client.send(JSON.stringify({ id: 3, method: "app/state/read",
    params: { browserStateId: "10000000-0000-4000-8000-000000000001", sinceRevision: null } }));
  const [crossOwner] = await once(client, "message");
  assert.match(JSON.parse(crossOwner.toString()).error.message, /changed browser owner/u);
  const closed = once(client, "close");
  granted = false;
  notify();
  await closed;
  assert.equal(unsubscribed, 1);
  granted = true;
  const replacement = new WebSocket(`${origin.replace(/^http/u, "ws")}/api/workbench-network/socket?capabilities=6`, { origin });
  context.after(() => replacement.terminate());
  await once(replacement, "message");
  const reloading = once(replacement, "close");
  sockets.close();
  await reloading;
  assert.equal(unsubscribed, 2, "reload releases subscriptions without waiting for a browser close frame");
  assert.ok(lines.some(line => line.includes("grant revoked")));
  assert.ok(lines.some(line => line.includes("connected (1 active)")));
  assert.ok(lines.some(line => line.includes("disconnected (0 active)")));
  assert.ok(lines.some(line => line.includes("WS out app:network (count: 2")));
  assert.ok(lines.every(line => !line.includes("privateAccess")));
});
