/*
 * No production exports. Protect peer catalog registration and sidebar reads through one socket.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DaemonIdSchema, ProjectIdSchema, ProjectIdentityKeySchema } from "workbench-shared/workbench/identity";
import type WorkbenchPresentationClient from "./state/WorkbenchPresentationClient";
import WorkbenchClientStateController from "./state/WorkbenchClientStateController";
import WorkbenchDaemonSession from "./WorkbenchDaemonSession";

test("disposing an attached session leaves its app-owned clients alive", () => {
  const released: string[] = [];
  const listen = () => () => undefined;
  const attached = {
    threads: {
      onConnectionOpen: listen, onDisconnect: listen, onWorkbenchNotification: listen,
      dispose: () => { released.push("threads"); },
    },
    daemon: {},
    projects: { dispose: () => { released.push("projects"); } },
    sidebar: { subscribe: listen, dispose: () => { released.push("sidebar"); } },
  } as unknown as NonNullable<ConstructorParameters<typeof WorkbenchDaemonSession>[0]["attached"]>;
  const session = new WorkbenchDaemonSession({
    daemonId: DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029"),
    hostname: "desktop",
    attached,
    appState: {} as WorkbenchClientStateController,
    presentation: {} as WorkbenchPresentationClient,
  });
  session.dispose();
  assert.deepEqual(released, []);
});

test("an attached session observes locations without registering them from the browser", async () => {
  const daemonId = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
  const projectId = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
  const project = {
    id: projectId, kind: "git", name: "repo", relativePath: "repo", rootPath: "/home/repo",
    lastCommitTimeMs: null, roots: [{ id: "repo", isPrimary: true, name: "repo", relativePath: "repo", rootPath: "/home/repo" }],
  };
  const catalog = { data: [project], aliases: [], rootPath: "/home" };
  let locationReads = 0;
  let locationWrites = 0;
  const listen = () => () => undefined;
  const attached = {
    threads: {
      connect: async () => {}, onConnectionOpen: listen, onDisconnect: listen,
      onWorkbenchNotification: listen,
    },
    daemon: {
      projects: {
        catalog: async () => catalog,
        locations: async () => { locationReads++; return { data: [] }; },
      },
    },
    projects: {
      getSnapshot: () => ({ projects: [project] }),
      installCatalog: async () => {},
      bindDaemonRegistration: () => {},
    },
    sidebar: { isObservingGlobal: () => true },
  } as unknown as NonNullable<ConstructorParameters<typeof WorkbenchDaemonSession>[0]["attached"]>;
  const appState = new WorkbenchClientStateController({ mode: "memory" });
  appState.ensureDaemonRegistration = async () => "attached-registration";
  const session = new WorkbenchDaemonSession({
    daemonId, hostname: "desktop", attached, appState,
    presentation: { mutate: async () => { locationWrites++; return { locations: [] }; } } as unknown as WorkbenchPresentationClient,
  });
  try {
    const observed = Promise.withResolvers<void>();
    const unsubscribe = session.subscribe(() => {
      if (session.getSnapshot().locations) observed.resolve();
    });
    await session.start();
    await observed.promise;
    unsubscribe();
    assert.equal(session.getSnapshot().catalog?.data[0]?.id, projectId);
    assert.equal(locationReads, 1);
    assert.equal(locationWrites, 0);
  } finally {
    session.dispose();
    appState.dispose();
  }
});

test("one peer socket registers concrete locations and reads its sidebar before becoming ready", async (context) => {
  context.mock.method(console, "warn", () => {});
  const originalSocket = globalThis.WebSocket;
  const originalWindow = globalThis.window;
  const daemonId = DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
  const projectId = ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
  const identityKey = ProjectIdentityKeySchema.parse("remote://example.test/team/repo");
  const project = {
    id: projectId, kind: "git", name: "repo", relativePath: "repo", rootPath: "/home/repo",
    lastCommitTimeMs: null, roots: [{ id: "repo", isPrimary: true, name: "repo", relativePath: "repo", rootPath: "/home/repo" }],
  };
  const catalog = { data: [project], aliases: [], rootPath: "/home" };
  const locations = { data: [{ identityKey, rootIdentityKeys: [identityKey], project }] };
  const requests: string[] = [];
  let rejectLocations = false;
  class Socket {
    static readonly OPEN = 1;
    readonly OPEN = 1;
    readyState = 1;
    private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
    constructor(readonly url: string) { queueMicrotask(() => this.emit("open", {})); }
    addEventListener(kind: string, listener: (event: { data?: string }) => void) {
      this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
    }
    private emit(kind: string, event: { data?: string }) {
      for (const listener of this.listeners.get(kind) ?? []) listener(event);
    }
    send(payload: string) {
      const request = JSON.parse(payload) as { id?: number; method: string };
      if (request.id === undefined) return;
      requests.push(request.method);
      if (request.method === "project/locations/read" && rejectLocations) {
        queueMicrotask(() => this.emit("message", { data: JSON.stringify({
          id: request.id, error: { code: -32000, message: "location identity unavailable" },
        }) }));
        return;
      }
      const result = request.method === "project/catalog/read" ? catalog
        : request.method === "project/locations/read" ? locations
          : request.method === "workbench/thread-state/open" ? {
            catalog, project: null,
            sidebar: { entries: [], error: null, freshness: "fresh", projectId, revision: 2 },
            pinnedThreadLayout: { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" },
            projectThreads: { projects: [] },
          }
          : request.method === "workbench/thread-state/global/open" ? {
            version: 7, catalog, homeThreadDisplayOrder: { displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder" },
            pinnedThreadLayout: { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" },
            projectSidebars: { projects: [{ entries: [], error: null, freshness: "fresh", projectId, revision: 1 }] },
          } : {};
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: request.id, result }) }));
    }
    close() { this.readyState = 3; this.emit("close", {}); }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.window = {
    cancelAnimationFrame: (handle: number) => globalThis.clearTimeout(handle),
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => globalThis.setTimeout(
      () => callback(performance.now()), 0,
    ) as unknown as number,
    setTimeout: globalThis.setTimeout,
  } as unknown as Window & typeof globalThis;
  const appState = new WorkbenchClientStateController({ mode: "memory" });
  const appRegistrationEntered = Promise.withResolvers<void>();
  const releaseAppRegistration = Promise.withResolvers<void>();
  appState.ensureDaemonRegistration = async () => {
    appRegistrationEntered.resolve();
    await releaseAppRegistration.promise;
    return "peer-registration";
  };
  const mutations: Array<{ daemonId: string; projectId: string }> = [];
  const registrationEntered = Promise.withResolvers<void>();
  const releaseRegistration = Promise.withResolvers<void>();
  const presentation = {
    mutate: async (input: { daemonId: string; catalog: typeof locations }) => {
    mutations.push({ daemonId: input.daemonId, projectId: input.catalog.data[0]!.project.id });
    registrationEntered.resolve();
    await releaseRegistration.promise;
    return { locations: [] };
  } } as unknown as WorkbenchPresentationClient;
  const session = new WorkbenchDaemonSession({
    daemonId, hostname: "laptop", resolveUrl: async () => "wss://peer.wb.inthedark.boo:52739/",
    appState, presentation,
  });
  try {
    const starting = session.start();
    await appRegistrationEntered.promise;
    try {
      assert.equal(requests.includes("project/catalog/read"), true,
        "browser registration must not block the daemon catalogue read");
      assert.equal(session.getSnapshot().phase, "ready");
      assert.equal(session.projects?.getSnapshot().projects[0]?.id, projectId);
      await session.observeProject(null);
      assert.equal(session.sidebar?.getProjectThreadSidebars().projects[0]?.projectId, projectId,
        "global thread rows must not wait for browser registration");
    } finally {
      releaseAppRegistration.resolve();
    }
    await registrationEntered.promise;
    try {
      assert.equal(session.getSnapshot().phase, "ready",
        "a presentation write must not hide an already-read daemon catalogue");
    } finally {
      releaseRegistration.resolve();
    }
    assert.equal(session.getSnapshot().phase, "ready");
    await starting;
    assert.deepEqual(mutations, [{ daemonId, projectId }]);
    assert.equal(session.projects?.getSnapshot().projects[0]?.rootPath, "/home/repo");
    await session.observeProject(null);
    assert.equal(session.sidebar?.getProjectThreadSidebars?.().projects[0]?.projectId, projectId);
    assert.equal(requests.filter(method => method === "project/catalog/read").length, 1);
    assert.equal(requests.filter(method => method === "workbench/thread-state/global/open").length, 1,
      "logical-project navigation keeps the aggregate observation instead of reopening it");
    await session.observeProject(projectId);
    assert.equal(session.sidebar?.getSnapshot()?.projectId, projectId);
    assert.equal(requests.includes("workbench/thread-state/global/close"), true);
    await session.observeProject(null);
    assert.equal(session.sidebar?.getProjectThreadSidebars().projects[0]?.projectId, projectId);
    rejectLocations = true;
    assert.equal(await session.refresh(), true,
      "a location identity failure must not hide the usable catalogue and thread rows");
    assert.equal(session.getSnapshot().phase, "ready");
    assert.equal(session.projects?.getSnapshot().projects[0]?.id, projectId);
    rejectLocations = false;
    const registrationFailed = Promise.withResolvers<void>();
    const unsubscribe = session.subscribe(() => {
      if (session.getSnapshot().error?.includes("disk busy")) {
        registrationFailed.resolve();
      }
    });
    presentation.mutate = async () => { throw new Error("disk busy"); };
    await session.refresh();
    await registrationFailed.promise;
    unsubscribe();
    assert.equal(session.getSnapshot().phase, "ready",
      "a failed presentation write must not hide the previously usable catalogue");
    session.dispose();
  } finally {
    releaseAppRegistration.resolve();
    session.dispose();
    appState.dispose();
    globalThis.WebSocket = originalSocket;
    globalThis.window = originalWindow;
  }
});
