/* No production exports. Protect independent source arrival, app registration and conflicting thread owners. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer, WebSocket as NodeWebSocket } from "ws";
import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import WorkbenchAppEventSocketController from "../runtime/WorkbenchAppEventSocketController";
import WorkbenchNetworkRoutes from "../network/WorkbenchNetworkRoutes";
import WorkbenchAppRpcClient from "../../client/workbench/app/WorkbenchAppRpcClient";
import WorkbenchWorkspaceClient from "../../client/workbench/app/WorkbenchWorkspaceClient";
import {
  DaemonWorkspaceObserveSchema, type DaemonWorkspaceObserve, type DaemonWorkspaceObservation,
} from "workbench-shared/workbench/workspace/workspace-observation";
import { DaemonIdSchema, ProjectIdSchema, ProjectIdentityKeySchema, ThreadReferenceSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchDaemonSource from "./WorkbenchDaemonSource";
import WorkbenchDaemonSources from "./WorkbenchDaemonSources";
import WorkbenchWorkspaceController from "./WorkbenchWorkspaceController";
import WorkbenchWorkspaceThreads from "./WorkbenchWorkspaceThreads";
import WorkbenchPresentationRepository from "../state/WorkbenchPresentationRepository";
import WorkbenchPresentationController from "../state/WorkbenchPresentationController";

const a = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000001");
const b = DaemonIdSchema.parse("00000000-0000-4000-8000-000000000002");
const threadId = WorkbenchThreadIdSchema.parse("00000000-0000-4000-8000-000000000003");
const projectId = ProjectIdSchema.parse("local-project");
const identityKey = ProjectIdentityKeySchema.parse("local://C:/local-project");
const catalogue = { data: [{
  identityKey, rootIdentityKeys: [identityKey],
  project: { id: projectId, kind: "git" as const, name: "local-project",
    rootPath: "C:/local-project", relativePath: "local-project", lastCommitTimeMs: null,
    roots: [{ id: "root", isPrimary: true, name: "root", rootPath: "C:/local-project", relativePath: "" }] },
}] };
type Query = { id: number; params: DaemonWorkspaceObserve };
type Payload = {
  [Kind in DaemonWorkspaceObservation["kind"]]: Omit<Extract<DaemonWorkspaceObservation, { kind: Kind }>,
    "subscriptionId" | "generation" | "revision">;
}[DaemonWorkspaceObservation["kind"]];

class Socket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly requests: Query[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(readonly url: string) { super(); }
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
  send(value: string) {
    const frame = JSON.parse(value) as { id: number; method: string; params: object };
    if (frame.method === "workspace/observe") {
      this.requests.push({ id: frame.id, params: DaemonWorkspaceObserveSchema.parse(frame.params) });
      for (const listener of [...this.listeners]) listener();
    } else this.message({ id: frame.id, result: { accepted: true } });
  }
  query(kind: DaemonWorkspaceObserve["query"]["kind"]) {
    return new Promise<Query>(resolve => {
      const changed = () => {
        const request = this.requests.find(item => item.params.query.kind === kind);
        if (!request) return;
        this.listeners.delete(changed);
        resolve(request);
      };
      this.listeners.add(changed);
      changed();
    });
  }
  push(query: Query, payload: Payload, revision = 1) {
    this.message({ method: "workspace/updated", params: { ...payload, revision,
      generation: query.params.generation, subscriptionId: query.params.subscriptionId } });
  }
  private message(value: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

async function fixture(context: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-owners-"));
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(directory, "presentation.sqlite3") });
  await repository.start();
  const presentation = new WorkbenchPresentationController(repository);
  const warnings: string[] = [];
  const sockets = new Map([[a, Promise.withResolvers<Socket>()], [b, Promise.withResolvers<Socket>()]]);
  const sources = new WorkbenchDaemonSources({
    network: {
      daemonSources: () => ({ current: true,
        attached: { protocol: 1, daemonId: a, hostname: "a", state: "ready", wakeEnabled: true },
        localOrigin: "http://127.0.0.1:12345",
        discovery: { refreshing: false, peers: [{
          peerId: "b", hostname: "b", phase: "verified",
          identity: { protocol: 1, daemonId: b, hostname: "b", state: "ready", wakeEnabled: true },
          origin: "http://100.80.0.2:52739",
          endpoints: { httpOrigin: "http://100.80.0.2:52739", secureOrigin: null },
        }] } }),
      canAccessPeer: () => true, subscribe: () => () => {},
    },
    warn: message => warnings.push(message),
    createSource: descriptor => new WorkbenchDaemonSource(descriptor, {
      warn: message => warnings.push(message),
      createSocket: url => {
        const socket = new Socket(url);
        sockets.get(descriptor.daemonId)!.resolve(socket);
        return socket as unknown as WebSocket;
      },
    }),
  });
  const workspace = new WorkbenchWorkspaceController({ sources, presentation, warn: message => warnings.push(message) });
  const threads = new WorkbenchWorkspaceThreads({ sources, presentation, warn: message => warnings.push(message) });
  context.after(async () => {
    threads.dispose(); workspace.dispose(); sources.dispose(); presentation.close();
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  workspace.start(); threads.start(); sources.start();
  return { repository, presentation, sources, workspace, threads, warnings,
    async open(id: typeof a) {
      const socket = await sockets.get(id)!.promise;
      const ready = sources.get(id)!.socket.connect();
      socket.open();
      await ready;
      return socket;
    } };
}

test("available catalogue facts register and render without waiting for a second daemon", async context => {
  const owners = await fixture(context);
  const socket = await owners.open(a);
  socket.push(await socket.query("catalogue"), { kind: "catalogue", phase: "current", failure: null,
    catalogue: { data: catalogue.data.map(item => item.project), rootPath: "C:/" }, locations: catalogue });
  assert.equal(owners.workspace.getSnapshot().projects.length, 1);
  assert.equal(owners.workspace.getSnapshot().catalogues.find(item => item.daemonId === b)?.phase, "pending");
  assert.equal(owners.presentation.read().locations[0]?.target.daemonId, a);
  assert.deepEqual(owners.warnings, []);
});

test("registration failure preserves the observed folder and does not spin on the same catalogue", async context => {
  const owners = await fixture(context);
  const mutate = owners.presentation.mutate.bind(owners.presentation);
  let attempts = 0;
  context.mock.method(owners.presentation, "mutate", (value: Parameters<typeof mutate>[0]) => {
    if (value.kind === "registerLocations" && ++attempts === 1) throw new Error("storage unavailable");
    return mutate(value);
  });
  const socket = await owners.open(a);
  const query = await socket.query("catalogue");
  const payload = { kind: "catalogue" as const, phase: "current" as const, failure: null,
    catalogue: { data: catalogue.data.map(item => item.project), rootPath: "C:/" }, locations: catalogue };
  socket.push(query, payload);
  assert.equal(owners.workspace.getSnapshot().observedProjects.length, 1);
  assert.equal(owners.workspace.getSnapshot().projects.length, 0);
  const release = owners.workspace.retain();
  release();
  assert.equal(attempts, 1);
  socket.push(query, payload, 2);
  assert.equal(owners.workspace.getSnapshot().projects.length, 1);
  assert.equal(owners.workspace.getSnapshot().observedProjects.length, 0);
});

test("thread routing progresses on its known source and fences a later conflicting owner", async context => {
  const owners = await fixture(context);
  const observation = owners.threads.observe(threadId, () => {});
  const socketA = await owners.open(a);
  socketA.push(await socketA.query("threadIdentity"), {
    kind: "threadIdentity", phase: "current", failure: null,
    identity: { threadId, projectId, harness: "codex" },
  });
  assert.equal(observation.getSnapshot().phase, "current");
  const cancellation = new AbortController();
  assert.equal(await owners.threads.withThread(threadId, async source => source.id, cancellation.signal), a);
  const socketB = await owners.open(b);
  socketB.push(await socketB.query("threadIdentity"), {
    kind: "threadIdentity", phase: "current", failure: null,
    identity: { threadId, projectId, harness: "codex" },
  });
  assert.equal(observation.getSnapshot().phase, "conflict");
  await assert.rejects(owners.threads.withThread(threadId,
    async () => assert.fail("Conflicting ownership must not dispatch"), cancellation.signal), /conflicting/);
  observation.release();
});

async function wireDaemon(context: TestContext) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const requests: Array<{ socket: NodeWebSocket; id: number; method: string; params: object }> = [];
  const listeners = new Set<() => void>();
  const connections: NodeWebSocket[] = [];
  server.on("connection", socket => {
    connections.push(socket);
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes.toString()) as { id: number; method: string; params: object };
      requests.push({ socket, ...frame });
      if (frame.method === "workspace/release") socket.send(JSON.stringify({ id: frame.id, result: { released: true } }));
      for (const listener of [...listeners]) listener();
    });
  });
  context.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const wait = (predicate: (request: typeof requests[number]) => boolean) => new Promise<typeof requests[number]>(resolve => {
    const changed = () => {
      const result = requests.find(predicate);
      if (!result) return;
      listeners.delete(changed); resolve(result);
    };
    listeners.add(changed); changed();
  });
  return {
    origin: `http://127.0.0.1:${address.port}`, requests, connections, wait,
    query: (kind: DaemonWorkspaceObserve["query"]["kind"], connection = 0) => wait(request =>
      request.socket === connections[connection] && request.method === "workspace/observe"
      && DaemonWorkspaceObserveSchema.parse(request.params).query.kind === kind),
    answer: (request: typeof requests[number], payload: Payload, revision = 1) => {
      const query = DaemonWorkspaceObserveSchema.parse(request.params);
      request.socket.send(JSON.stringify({ id: request.id, result: { ...payload,
        subscriptionId: query.subscriptionId, generation: query.generation, revision } }));
    },
    push: (request: typeof requests[number], payload: Payload, revision = 2) => {
      const query = DaemonWorkspaceObserveSchema.parse(request.params);
      request.socket.send(JSON.stringify({ method: "workspace/updated", params: { ...payload,
        subscriptionId: query.subscriptionId, generation: query.generation, revision } }));
    },
  };
}

test("real app sockets share daemon interests, route mutations and isolate a held source across clients", async context => {
  const daemonA = await wireDaemon(context);
  const daemonB = await wireDaemon(context);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-wire-"));
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(directory, "presentation.sqlite3") });
  await repository.start();
  const presentation = new WorkbenchPresentationController(repository);
  const warnings: string[] = [];
  const sources = new WorkbenchDaemonSources({
    network: {
      daemonSources: () => ({ current: true,
        attached: { protocol: 1, daemonId: a, hostname: "a", state: "ready", wakeEnabled: true },
        localOrigin: daemonA.origin,
        discovery: { refreshing: false, peers: [{
          peerId: "b", hostname: "b", phase: "verified",
          identity: { protocol: 1, daemonId: b, hostname: "b", state: "ready", wakeEnabled: true },
          origin: daemonB.origin, endpoints: { httpOrigin: daemonB.origin, secureOrigin: null },
        }] } }),
      canAccessPeer: () => true, subscribe: () => () => {},
    },
    warn: message => warnings.push(message),
  });
  const workspace = new WorkbenchWorkspaceController({ sources, presentation, warn: message => warnings.push(message) });
  const threads = new WorkbenchWorkspaceThreads({ sources, presentation, warn: message => warnings.push(message) });
  const network = {
    getFacts: () => ({ phase: "pending" as const, failure: null, snapshot: null }),
    ingress: () => ({ deviceNodeId: null, manageApp: true, manageNetwork: true, trustHost: false }),
    discovery: () => ({ refreshing: false, peers: [] }),
    subscribe: () => () => {},
    action: async () => ({ kind: "ok" as const }),
  };
  const routes = new WorkbenchNetworkRoutes(network);
  const appSockets = new WorkbenchAppEventSocketController({
    logger: new WorkbenchProcessLogger({ color: false, writeOutput: () => {}, writeError: line => warnings.push(line) }),
    network, routes, sources, workspace, workspaceThreads: threads, presentation,
    runtime: { read: () => ({ frontendGeneration: null, reloadDirt: { dirtyScopes: [], pendingScopes: [], error: null } }),
      subscribe: () => () => {} },
    state: {
      readWorkspaceBrowser: async () => { throw new Error("Unexpected browser-state read."); },
      mutateBrowser: async () => { throw new Error("Unexpected browser-state mutation."); },
      subscribeBrowser: () => () => {},
    },
  });
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on("upgrade", (request, socket, head) => appSockets.handleUpgrade(request, socket, head));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const clients: Array<{ rpc: WorkbenchAppRpcClient; workspace: WorkbenchWorkspaceClient }> = [];
  context.after(async () => {
    for (const client of clients) { client.workspace.dispose(); client.rpc.dispose(); }
    appSockets.close(); routes.close();
    threads.dispose(); workspace.dispose(); sources.dispose(); presentation.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await repository.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  workspace.start(); threads.start(); sources.start();
  const connect = async () => {
    const rpc = new WorkbenchAppRpcClient({
      origin, socket: url => new NodeWebSocket(url, { origin }) as unknown as WebSocket,
    });
    const client = { rpc, workspace: new WorkbenchWorkspaceClient(rpc) };
    clients.push(client);
    const ready = new Promise<void>(resolve => { const stop = rpc.onOpen(() => { stop(); resolve(); }); });
    rpc.start(); await ready;
    return client;
  };
  const waitFor = <Value>(observation: { getSnapshot(): Value; subscribe(listener: () => void): () => void },
    predicate: (value: Value) => boolean) => new Promise<Value>(resolve => {
    const changed = () => { const value = observation.getSnapshot(); if (predicate(value)) { stop(); resolve(value); } };
    const stop = observation.subscribe(changed); changed();
  });
  const first = await connect();
  const second = await connect();
  const firstProjects = first.workspace.observe({ kind: "projects" });
  const secondProjects = second.workspace.observe({ kind: "projects" });
  const aCatalogue = await daemonA.query("catalogue");
  await daemonB.query("catalogue");
  daemonA.answer(aCatalogue, { kind: "catalogue", phase: "current", failure: null,
    catalogue: { data: catalogue.data.map(item => item.project), aliases: [], rootPath: "C:/" }, locations: catalogue });
  const visible = await waitFor(firstProjects, snapshot => snapshot.value?.data.projects.length === 1);
  await waitFor(secondProjects, snapshot => snapshot.value?.data.projects.length === 1);
  assert.equal(visible.value?.data.catalogues.find(source => source.daemonId === b)?.phase, "pending");
  assert.equal(daemonA.connections.length, 1);
  assert.equal(daemonB.connections.length, 1);
  assert.equal(daemonA.requests.filter(request => request.method === "workspace/observe"
    && DaemonWorkspaceObserveSchema.parse(request.params).query.kind === "catalogue").length, 1);

  const owner = second.workspace.observe({ kind: "threadOwner", threadId: ThreadReferenceSchema.parse(threadId) });
  daemonA.answer(await daemonA.query("threadIdentity"), {
    kind: "threadIdentity", phase: "current", failure: null, identity: { threadId, projectId, harness: "codex" },
  });
  await waitFor(owner, snapshot => snapshot.value?.data.phase === "current");
  const mutation = second.rpc.requestRaw({ method: "workspace/thread/action",
    params: { threadId, intent: { kind: "pin", pinned: true } } });
  const dispatch = await daemonA.wait(request => request.method === "workbench/thread-state/pin/set");
  assert.deepEqual(dispatch.params, { projectId, identity: { threadId, harness: "codex" }, pinned: true });
  dispatch.socket.send(JSON.stringify({ id: dispatch.id, result: { accepted: true, revision: 1 } }));
  assert.deepEqual(await mutation, { accepted: true, revision: 1 });
  assert.equal(daemonB.requests.some(request => request.method === dispatch.method), false);

  const content = "file contents\n".repeat(100_000);
  const save = second.workspace.request("project/file/save", {
    path: "large.txt", content, expectedMtimeMs: 0,
  }, { kind: "folder", location: { daemonId: a, projectId } });
  const write = await daemonA.wait(request => request.method === "project/file/save");
  assert.deepEqual(write.params, { projectId, path: "large.txt", content, expectedMtimeMs: 0 });
  write.socket.send(JSON.stringify({ id: write.id, result: { saved: true } }));
  assert.deepEqual(await save, { saved: true });

  const largeContent = "markdown content\n".repeat(1_100_000);
  const read = second.workspace.request("project/file/read", { path: "large.md" },
    { kind: "folder", location: { daemonId: a, projectId } });
  const readRequest = await daemonA.wait(request => request.method === "project/file/read");
  const file = { content: largeContent, headContent: null, mtimeMs: 1,
    path: "large.md", projectId, updatedAt: new Date(1).toISOString() };
  readRequest.socket.send(JSON.stringify({ id: readRequest.id, result: file }));
  assert.deepEqual(await read, file);

  first.workspace.dispose(); first.rpc.dispose();
  daemonA.push(aCatalogue, { kind: "catalogue", phase: "current", failure: null,
    catalogue: { data: catalogue.data.map(item => ({ ...item.project, name: "Renamed" })), aliases: [], rootPath: "C:/" },
    locations: { data: catalogue.data.map(item => ({ ...item, project: { ...item.project, name: "Renamed" } })) } });
  await waitFor(secondProjects, snapshot => snapshot.value?.data.projects[0]?.locations[0]?.name === "Renamed");
  assert.equal(daemonA.connections.length, 1);

  const unsettled = second.rpc.requestRaw({ method: "workspace/thread/action",
    params: { threadId, intent: { kind: "pin", pinned: false } } });
  const interrupted = assert.rejects(unsettled, error =>
    error instanceof Error && "dispatched" in error && error.dispatched === true);
  await daemonA.wait(request => request.method === dispatch.method && request !== dispatch);
  const source = sources.get(a)!;
  source.socket.setSuspended(true);
  await interrupted;
  await waitFor(secondProjects, snapshot => snapshot.value?.data.sources.some(item =>
    item.daemonId === a && item.connection !== "current") === true);
  source.socket.setSuspended(false);
  const restoredCatalogue = await daemonA.query("catalogue", 1);
  daemonA.answer(restoredCatalogue, { kind: "catalogue", phase: "current", failure: null,
    catalogue: { data: catalogue.data.map(item => item.project), aliases: [], rootPath: "C:/" }, locations: catalogue });
  daemonA.answer(await daemonA.query("threadIdentity", 1), {
    kind: "threadIdentity", phase: "current", failure: null, identity: { threadId, projectId, harness: "codex" },
  });
  await waitFor(owner, snapshot => snapshot.value?.data.phase === "current");
  assert.equal(daemonA.connections.length, 2);
  assert.equal(daemonA.requests.filter(request => request.method === dispatch.method).length, 2,
    "reconnection restores subscriptions but never resends the interrupted mutation");

  daemonB.answer(await daemonB.query("threadIdentity"), {
    kind: "threadIdentity", phase: "current", failure: null, identity: { threadId, projectId, harness: "codex" },
  });
  await waitFor(owner, snapshot => snapshot.value?.data.phase === "conflict");
  await assert.rejects(second.rpc.requestRaw({ method: "workspace/thread/action",
    params: { threadId, intent: { kind: "pin", pinned: false } } }), /conflicting/i);
  assert.equal(daemonA.requests.filter(request => request.method === dispatch.method).length, 2);
  owner.release(); secondProjects.release();
});
