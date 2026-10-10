/* No exports. Protect app socket admission, device-independent reload controls, browser-state isolation, idle grant revocation and event-named traffic logs. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import { IDLE_RELOAD_OPERATION } from "workbench-shared/reload/workbench-reload";
import WorkbenchNetworkRoutes from "../network/WorkbenchNetworkRoutes";
import WorkbenchAppEventSocketController from "./WorkbenchAppEventSocketController";

test("connected devices can admit reload and update operations without app-management capability", async context => {
  const network = {
    ingress: () => ({ deviceNodeId: "visitor", manageApp: false, manageNetwork: false, trustHost: false }),
    discovery: () => ({ refreshing: false, peers: [] }),
    getFacts: () => ({ phase: "current" as const, failure: null, snapshot: null }),
    subscribe: () => () => {},
    action: async () => ({ kind: "ok" as const }),
  };
  const routes = new WorkbenchNetworkRoutes(network);
  const admitted: string[] = [];
  const admission = (action: string) => ({
    cancel: () => {},
    start: async () => { admitted.push(action); },
  });
  const sockets = new WorkbenchAppEventSocketController({
    logger: new WorkbenchProcessLogger({ color: false, writeOutput: () => {}, writeError: () => {} }),
    network,
    routes,
    runtime: {
      read: () => ({}),
      subscribe: () => () => {},
      operations: {
        read: () => IDLE_RELOAD_OPERATION,
        subscribe: () => () => {},
        admitReloadAll: () => admission("reload"),
        admitPull: (_daemonId, reload) => admission(reload ? "pull-and-reload" : "pull"),
      },
    },
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
  const client = new WebSocket(`${origin.replace(/^http/u, "ws")}/api/workbench-network/socket`, { origin });
  context.after(() => client.terminate());
  await once(client, "open");
  const request = async (id: number, method: "app/reload/all" | "app/update/pull", params: object) => {
    const reply = once(client, "message");
    client.send(JSON.stringify({ id, method, params }));
    return JSON.parse((await reply)[0].toString()) as { result?: object; error?: { message: string } };
  };
  assert.deepEqual((await request(1, "app/reload/all", {})).result, { admitted: true });
  assert.deepEqual((await request(2, "app/update/pull", { reload: false })).result, { admitted: true });
  assert.deepEqual((await request(3, "app/update/pull", { reload: true })).result, { admitted: true });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(admitted, ["reload", "pull", "pull-and-reload"]);
});

test("an idle app socket closes on grant revocation and state mutations cannot switch browser identity", async context => {
  let granted = true;
  const listeners = new Set<() => void>();
  const lines: string[] = [];
  const network = {
    ingress: () => granted ? { deviceNodeId: null, manageApp: true, manageNetwork: true, trustHost: false } : null,
    discovery: () => ({ refreshing: false, peers: [] }),
    getFacts: () => ({ phase: "pending" as const, failure: null, snapshot: null }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    action: async () => ({ kind: "ok" as const }),
  };
  const routes = new WorkbenchNetworkRoutes(network);
  const mutations: Array<string | undefined> = [];
  const mutationEntered = Promise.withResolvers<void>();
  const releaseMutation = Promise.withResolvers<void>();
  let holdMutation = false;
  const sockets = new WorkbenchAppEventSocketController({
    logger: new WorkbenchProcessLogger({ color: false,
      writeOutput: line => lines.push(line), writeError: line => lines.push(line) }),
    network, routes,
    state: {
      readWorkspaceBrowser: async () => { throw new Error("Unexpected read."); },
      mutateBrowser: async browserStateId => {
        mutations.push(browserStateId);
        if (holdMutation) {
          mutationEntered.resolve();
          await releaseMutation.promise;
        }
        return { daemonRegistrationId: "registration", revision: 1, oldestAvailableRevision: 0,
          kind: "delta", rows: {
            composerDraftAttachments: [], composerDraftReferences: [], composerDrafts: [], fileDrafts: [], globalPreferences: [],
            modelPreferences: [], modelGroupDisclosures: [], lastLaunchTarget: [], logicalProjectPreferences: [],
            projectExpandedDirectories: [], projectPreferences: [],
            projectSidebarFolders: [], projectSidebarPreferences: [], questionnaireDraftAnswers: [],
            questionnaireDraftAttachments: [], questionnaireDraftSelections: [], questionnaireDrafts: [],
          } };
      },
      subscribeBrowser: () => () => {},
    },
  });
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on("upgrade", (request, socket, head) => sockets.handleUpgrade(request, socket, head));
  const clients: WebSocket[] = [];
  context.after(async () => {
    for (const client of clients) client.terminate();
    sockets.close(); routes.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const connect = async () => {
    const client = new WebSocket(`${origin.replace(/^http/u, "ws")}/api/workbench-network/socket`, { origin });
    clients.push(client); await once(client, "open"); return client;
  };
  const client = await connect();
  const mutate = async (id: number, browserStateId: string | null) => {
    const reply = once(client, "message");
    client.send(JSON.stringify({ id, method: "app/state/mutate", params: { browserStateId,
      mutation: { action: "delete", identity: { kind: "globalPreference", key: "theme" } } } }));
    return JSON.parse((await reply)[0].toString()) as { result?: object; error?: { message: string } };
  };
  assert.ok((await mutate(1, null)).result);
  assert.match((await mutate(2, "10000000-0000-4000-8000-000000000001")).error?.message ?? "", /browser owner/);
  assert.deepEqual(mutations, [undefined]);
  const closed = once(client, "close");
  granted = false;
  for (const listener of [...listeners]) listener();
  await closed;
  assert.equal(listeners.size, 0);
  granted = true;
  const replacement = await connect();
  const retired = once(replacement, "close");
  holdMutation = true;
  replacement.send(JSON.stringify({ id: 3, method: "app/state/mutate", params: {
    browserStateId: null,
    mutation: { action: "delete", identity: { kind: "globalPreference", key: "theme" } },
  } }));
  await mutationEntered.promise;
  const quiescing = sockets.quiesce();
  let drained = false;
  void quiescing.then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  releaseMutation.resolve();
  await quiescing;
  await retired;
  sockets.resume();
  const recovered = await connect();
  const closedAgain = once(recovered, "close");
  sockets.close();
  await closedAgain;
  assert.equal(listeners.size, 0);
  assert.ok(lines.some(line => line.includes("grant revoked")));
  // Traffic lines name the request each RPC frame carries, not only its envelope.
  assert.ok(lines.some(line => line.includes("WS in app:rpc app/state/mutate (count:")));
  assert.ok(lines.some(line => line.includes("WS out app:rpc app/state/mutate (count:")));
});
