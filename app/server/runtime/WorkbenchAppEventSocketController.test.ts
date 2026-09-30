/* No exports. Protect app socket admission, browser-state isolation and idle grant revocation. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import WorkbenchNetworkRoutes from "../network/WorkbenchNetworkRoutes";
import WorkbenchAppEventSocketController from "./WorkbenchAppEventSocketController";

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
  const sockets = new WorkbenchAppEventSocketController({
    logger: new WorkbenchProcessLogger({ color: false,
      writeOutput: line => lines.push(line), writeError: line => lines.push(line) }),
    network, routes,
    state: {
      readWorkspaceBrowser: async () => { throw new Error("Unexpected read."); },
      mutateBrowser: async browserStateId => {
        mutations.push(browserStateId);
        return { daemonRegistrationId: "registration", revision: 1, oldestAvailableRevision: 0,
          kind: "delta", rows: {
            composerDraftAttachments: [], composerDrafts: [], fileDrafts: [], globalPreferences: [],
            modelPreferences: [], modelGroupDisclosures: [], lastLaunchTarget: [], projectExpandedDirectories: [], projectPreferences: [],
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
  sockets.close();
  await retired;
  assert.equal(listeners.size, 0);
  assert.ok(lines.some(line => line.includes("grant revoked")));
});
