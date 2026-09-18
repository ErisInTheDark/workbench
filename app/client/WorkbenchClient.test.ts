/*
 * Exports:
 * - No production exports; regression tests protect the explorer/sidebar render boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { captureTestOutput } from "../../test/capture-test-output.mts";

import type { ExplorerSnapshot, ThreadSummary, WorkbenchSubagentSummary } from "workbench-shared/types";
import type { WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { WorkbenchClient, areExplorerSnapshotsEquivalent, describeGlobalThreadStateOpenFailure, openWorkbenchGlobalThreadStateObservation, openWorkbenchThreadStateObservation } from "./WorkbenchClient.ts";
import { createHomeRoute, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type ThreadSidebarClient from "./workbench/thread/ThreadSidebarClient";
import WorkbenchClientStateController from "./workbench/state/WorkbenchClientStateController";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const fixtureIdentityValues = {
  ProjectId: {
    "project": fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  },
  WorkbenchThreadId: {
    "parent": fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent"),
  },
  WorkbenchTurnId: {
    "turn": fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  },
};

const thread = (id: string, updatedAt: number): ThreadSummary => ({
  agentNickname: null,
  agentRole: null,
  createdAt: 1,
  cwd: "C:/repo",
  harness: "codex",
  id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id),
  name: id,
  path: null,
  preview: id,
  source: "workbench",
  status: "active",
  updatedAt,
});

const subagent = (threadId: string, lastActivityAt: number): WorkbenchSubagentSummary => ({
  activityStatus: "active",
  createdAt: 1,
  cwd: "C:/repo",
  directSubagentIndex: 0,
  harness: "codex",
  lastActivityAt,
  lifecycle: { agent: { agentStatus: "working", turnId: fixtureIdentityValues.WorkbenchTurnId["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
  name: threadId,
  parentThreadId: fixtureIdentityValues.WorkbenchThreadId["parent"],
  pinned: false,
  profileId: "profile",
  profileName: "Profile",
  projectId: fixtureIdentityValues.ProjectId["project"],
  threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId),
  title: threadId,
  updatedAt: 1,
});

const explorer = (): ExplorerSnapshot => ({
  changes: {},
  currentPath: "",
  currentProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  currentThreadId: "",
  expandedDirectories: [],
  fontSize: 16,
  isProjectLoading: false,
  isThreadsLoading: false,
  locallyModifiedPaths: [],
  projectFileCandidates: [],
  projectFileIndexId: "index",
  projectFileIndexKey: "key",
  projectFilePaths: [],
  projects: [],
  root: "repo",
  rootPath: "C:/repo",
  roots: [],
  subagents: [subagent("subagent-a", 10), subagent("subagent-b", 20)],
  threads: [thread("thread-a", 10), thread("thread-b", 20)],
  threadsError: "",
  tree: [],
  workbenchStorageRootPath: "C:/repo/.workbench",
});

const sidebar = (): WorkbenchThreadSidebarSnapshot => ({
  entries: [], error: null, freshness: "fresh", projectId: fixtureIdentityValues.ProjectId["project"], revision: 1,
});

for (const order of ["stale-first", "winner-first", "leave-thread", "project-alias", "voice-events"] as const) {
  test(`route completion never reopens the winning route: ${order}`, async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalWebSocket = globalThis.WebSocket;
    const originalDaemonUrl = process.env.WORKBENCH_CODEX_APP_SERVER_URL;
    const pages: Array<{ threadId: string; complete: () => void }> = [];
    let pageReads = 0;
    const firstPage = Promise.withResolvers<void>();
    const secondPage = Promise.withResolvers<void>();
    const rootPath = "C:/repo";
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const projectId = fixtureIdentitySchemas.ProjectIdSchema.parse(order === "project-alias" ? "remote://github.com/team/repo" : "project");
    const roots = [{ id: "root", isPrimary: true, name: "repo", relativePath: ".", rootPath }];
    const entries = [firstId, secondId].map(threadId => ({
      entryKind: "thread", title: threadId, activityAt: 1,
      identity: { harness: "codex", threadId },
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    }));
    const sockets: EventTarget[] = [];
    class Socket extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      constructor() { super(); sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
      send(raw: string) {
        const request = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, unknown> };
        if (request.id === undefined) return;
        const respond = (result: object) => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: request.id, result }) }));
        const params = request.params ?? {};
        const threadId = String(params.threadId ?? "");
        let result: object;
        switch (request.method) {
          case "initialize": result = {}; break;
          case "voice/configuration/read": result = { selection: null }; break;
          case "workbench/daemon/reload-dirt/read": result = { revision: 1, snapshot: { dirtyScopes: [], pendingScopes: [], error: null } }; break;
          case "workbench/thread-state/open":
            result = {
              catalog: { data: [{ id: projectId, kind: "git", name: "repo", relativePath: "web/repo", rootPath, roots, lastCommitTimeMs: null }], rootPath,
                aliases: order === "project-alias" ? [{ alias: "web/repo", projectId }] : [] },
              project: { projectId, revision: 1, updateKind: "project", snapshot: { projectId, root: "repo", rootPath, roots, changes: {}, tree: [], workbenchStorageRootPath: `${rootPath}/.workbench` } },
              sidebar: { ...sidebar(), projectId, entries },
            };
            break;
          case "thread/identity/resolve": result = { data: { threadId, harness: "codex", projectId } }; break;
          case "workbench/thread-state/observe":
            result = { observation: { ...params, entries: entries.filter(entry => entry.identity.threadId === (params.target as { threadId: string }).threadId), revision: 1, freshness: "fresh", error: null, updateKind: "threadObservation" } };
            break;
          case "thread/page/read":
            pageReads++;
            if (pages.length >= 2) {
              this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: request.id, error: { code: -32000, message: "Unexpected repeated page read" } }) }));
              return;
            }
            pages.push({ threadId, complete: () => respond({
              thread: {
                ...thread(threadId, 1), cwd: rootPath, status: "idle", turns: [], turnHistory: [],
                isDraft: false, model: null, reasoningEffort: null, serviceTier: null, agentPath: null, tokenUsage: null,
              },
              nextCursor: null, browseResultEntries: [], questionnaireEntries: [], steerEntries: [],
            }) });
            (pages.length === 1 ? firstPage : secondPage).resolve();
            return;
          case "account/limits/read": result = {
            rateLimits: { limitId: null, limitName: null, primary: null, secondary: null, credits: null, planType: null },
            rateLimitsByLimitId: null,
          }; break;
          default:
            result = { accepted: true, data: [] };
        }
        queueMicrotask(() => respond(result));
      }
    }
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    process.env.WORKBENCH_CODEX_APP_SERVER_URL = "ws://workbench.test";
    globalThis.document = new EventTarget() as Document;
    globalThis.window = {
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
      requestAnimationFrame: (callback: FrameRequestCallback) => setImmediate(() => callback(performance.now())),
      cancelAnimationFrame: clearImmediate,
    } as unknown as Window & typeof globalThis;
    let client: Awaited<ReturnType<typeof WorkbenchClient>> | undefined;
    const clientStateController = new WorkbenchClientStateController();
    const route = (id: string): WorkbenchRoute => ({
      ...createHomeRoute(), projectId, view: "thread", threadId: id,
      threadTarget: { kind: "provider", threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse(id), harness: "codex" },
    });
    try {
      client = await WorkbenchClient({ clientStateController, initialRoute: { ...createHomeRoute(), view: "invalid", error: "fixture start" } });
      if (order === "voice-events") {
        let recovered = 0;
        const sidebar = client.threadSidebar as ThreadSidebarClient;
        sidebar.reopen = async () => { recovered++; };
        const notify = (method: string, params: object) => {
          for (const socket of sockets) socket.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ method, params }),
          }));
        };
        notify("voice/event", { type: "finished", sessionId: crypto.randomUUID() });
        assert.equal(recovered, 0, "voice notifications must not reopen thread observations");
        notify("workbench/thread-state/reset", {});
        assert.ok(recovered > 0, "real resets must still recover observations");
        return;
      }
      if (order === "project-alias") {
        const result = await client.controls.applyRoute({
          ...createHomeRoute(), projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("web/repo"), view: "project",
        });
        assert.equal(result.ok, true);
        assert.equal(result.canonicalRoute, undefined, "project alias adoption must not require a public URL redirect");
        assert.equal(clientStateController.resolveProjectId("web/repo"), projectId);
        const target = { kind: "draft" as const, draftId: fixtureIdentitySchemas.DraftIdSchema.parse(crypto.randomUUID()) };
        const failed = await client.controls.applyRoute({
          ...createHomeRoute(), projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("web/repo"),
          view: "thread", threadId: target.draftId, threadTarget: target,
        });
        assert.equal(failed.ok, false);
        assert.equal(client.getThreadController(projectId, target).getSnapshot().status, "failed");
        return;
      }
      const first = client.controls.applyRoute(route(firstId));
      await firstPage.promise;
      if (order === "leave-thread") {
        await client.controls.applyRoute({ ...createHomeRoute(), view: "invalid", error: "left" });
        pages[0]!.complete();
        await first;
        assert.equal(client.threadRuntime.getSnapshot().currentThread, null);
        assert.equal(pageReads, 1);
      } else {
        const second = client.controls.applyRoute(route(secondId));
        await secondPage.promise;
        const firstIndex = order === "stale-first" ? 0 : 1;
        pages[firstIndex]!.complete();
        await (firstIndex === 0 ? first : second);
        pages[1 - firstIndex]!.complete();
        await Promise.all([first, second]);
        assert.equal(client.threadRuntime.getSnapshot().currentThread?.id, secondId);
        assert.equal(pageReads, 2);
      }
    } finally {
      await (client?.threadSidebar as ThreadSidebarClient | undefined)?.close();
      client?.dispose();
      clientStateController.dispose();
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
      globalThis.WebSocket = originalWebSocket;
      if (originalDaemonUrl === undefined) delete process.env.WORKBENCH_CODEX_APP_SERVER_URL;
      else process.env.WORKBENCH_CODEX_APP_SERVER_URL = originalDaemonUrl;
    }
  });
}

test("thread-state open negotiates incremental delivery with a complete bootstrap", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 }> = [];
  const catalogs: unknown[] = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: (catalog) => { catalogs.push(catalog); },
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async (params) => {
      requests.push(params);
      return { catalog: { data: [], rootPath: "C:/projects" }, project: null, sidebar: sidebar() };
    },
  });
  assert.deepEqual(requests, [{ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 5 }]);
  assert.equal(result.sidebar.projectId, "project");
  assert.deepEqual(result.pinnedThreadLayout, {
    displayOrder: {},
    revision: 0,
    updateKind: "pinnedThreadLayout",
  });
  assert.deepEqual(result.projectThreads, { projects: [] });
  assert.equal(catalogs.length, 1);
});

test("global thread-state open installs a catalog and full sidebars without a selected project snapshot", async () => {
  const catalogs: unknown[] = [];
  const versions: Array<4 | 5 | 6 | 7> = [];
  const result = await openWorkbenchGlobalThreadStateObservation({
    installCatalog: (catalog) => { catalogs.push(catalog); },
    request: async (version) => {
      versions.push(version);
      return {
        catalog: { data: [], rootPath: "C:/projects" },
        homeThreadDisplayOrder: { displayOrder: {}, revision: 2, updateKind: "homeThreadDisplayOrder" },
        pinnedThreadLayout: { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" },
        projectSidebars: {
          projects: [
            { ...sidebar(), projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha") },
            { ...sidebar(), projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") },
          ],
        },
        version: 7,
      };
    },
  });
  assert.deepEqual(versions, [7]);
  assert.deepEqual(catalogs, [{ data: [], aliases: [], rootPath: "C:/projects" }]);
  assert.deepEqual(result.projectSidebars.projects.map(({ projectId }) => projectId), ["alpha", "beta"]);
  assert.equal(result.homeThreadDisplayOrder?.revision, 2);
  assert.equal("project" in result, false);
});

test("global thread-state open falls back to read-only version 4 only for an old protocol rejection", async () => {
  const versions: Array<4 | 5 | 6 | 7> = [];
  const result = await openWorkbenchGlobalThreadStateObservation({
    installCatalog: () => undefined,
    request: async (version) => {
      versions.push(version);
      if (version !== 4) throw new WorkbenchDaemonRequestError(
        "Invalid literal value, expected 4",
        "invalidThreadStateMutation" as never,
      );
      return {
        catalog: { data: [], rootPath: "C:/projects" },
        pinnedThreadLayout: { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" },
        projectSidebars: { projects: [] },
      };
    },
  });
  assert.deepEqual(versions, [7, 6, 5, 4]);
  assert.equal(result.homeThreadDisplayOrder, null);
});

test("global thread-state open preserves version 5 home ordering during a mixed reload", async () => {
  const versions: Array<4 | 5 | 6 | 7> = [];
  const result = await openWorkbenchGlobalThreadStateObservation({
    installCatalog: () => undefined,
    request: async (version) => {
      versions.push(version);
      if (version > 5) throw new WorkbenchDaemonRequestError(
        "Invalid literal value, expected 5",
        "invalidThreadStateMutation" as never,
      );
      return {
        catalog: { data: [], rootPath: "C:/projects" },
        homeThreadDisplayOrder: { displayOrder: {}, revision: 7, updateKind: "homeThreadDisplayOrder" },
        pinnedThreadLayout: { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" },
        projectSidebars: { projects: [] },
        version: 5,
      };
    },
  });
  assert.deepEqual(versions, [7, 6, 5]);
  assert.equal(result.homeThreadDisplayOrder?.revision, 7);
});

test("global thread-state failures retain the actual server error and request boundary", () => {
  assert.equal(
    describeGlobalThreadStateOpenFailure(new Error("storage read failed")),
    "Unable to open all-project threads through workbench/thread-state/global/open: storage read failed",
  );
});

test("thread-state open negotiates back to version 2 while the server is still old", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 }> = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async (params) => {
      requests.push(params);
      if (params.version && params.version > 2) throw new Error("Invalid input: expected 2");
      return {
        catalog: { data: [], rootPath: "C:/projects" },
        project: null,
        projectThreads: { projects: [] },
        sidebar: sidebar(),
      };
    },
  });
  assert.deepEqual(requests, [
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 5 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 4 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 3 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 2 },
  ]);
  assert.equal(result.sidebar.projectId, "project");
  assert.deepEqual(result.projectThreads, { projects: [] });
});

test("thread-state open falls back from version 4 on the typed old-server rejection", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 }> = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async (params) => {
      requests.push(params);
      if (params.version && params.version >= 4) {
        throw new WorkbenchDaemonRequestError(
          "Invalid input",
          "invalidThreadStateMutation" as never,
        );
      }
      return {
        catalog: { data: [], rootPath: "C:/projects" },
        project: null,
        projectThreads: { projects: [] },
        sidebar: sidebar(),
      };
    },
  });
  assert.deepEqual(requests, [
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 5 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 4 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 3 },
  ]);
  assert.equal(result.sidebar.projectId, "project");
});

test("thread-state open retries legacy only for an unsupported version field", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 }> = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async (params) => {
      requests.push(params);
      if (params.version !== undefined) throw new Error('Unrecognized key: "version"');
      return sidebar();
    },
  });
  assert.deepEqual(requests, [
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 5 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 4 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 3 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 2 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") },
  ]);
  assert.equal(result.sidebar.projectId, "project");
});

test("thread-state open accepts a composite bootstrap from the versionless compatibility retry", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 }> = [];
  const catalogs: unknown[] = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: (catalog) => { catalogs.push(catalog); },
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async (params) => {
      requests.push(params);
      if (params.version !== undefined) throw new Error('Unrecognized key: "version"');
      return {
        catalog: { data: [], rootPath: "C:/projects" },
        project: null,
        projectThreads: { projects: [] },
        sidebar: sidebar(),
      };
    },
  });
  assert.deepEqual(requests, [
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 5 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 4 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 3 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 2 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") },
  ]);
  assert.equal(result.sidebar.projectId, "project");
  assert.equal(catalogs.length, 1);
});

test("thread-state open conforms malformed composite nodes without discarding valid sidebar siblings", async (context) => {
  let requests = 0;
  const catalogs: unknown[] = [];
  const diagnostics: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values) => { diagnostics.push(values.map(String).join(" ")); };
  context.after(() => { console.error = originalConsoleError; });
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: (catalog) => { catalogs.push(catalog); },
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async () => {
      requests += 1;
      return {
        catalog: { data: "invalid", rootPath: "C:/projects" },
        project: null,
        sidebar: sidebar(),
      };
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.sidebar.projectId, "project");
  assert.deepEqual(catalogs, [{ data: [], aliases: [], rootPath: "C:/projects" }]);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /Repaired Workbench thread-state open response/u);
});

test("thread-state conformance strips retired arc reload scopes without dropping the entry", async (context) => {
  const diagnostics: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values) => { diagnostics.push(values.map(String).join(" ")); };
  context.after(() => { console.error = originalConsoleError; });
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async () => ({
      catalog: { data: [], rootPath: "C:/projects" },
      project: null,
      sidebar: {
        ...sidebar(),
        entries: [{
          activityAt: 1,
          entryKind: "thread",
          gitArc: {
            checkpointCommit: "a".repeat(40),
            claimedPaths: ["webapp"],
            intentDescription: "",
            intentName: "work",
            phase: "active",
            proposals: [],
            reloadScopes: ["server:core"],
            updatedAt: "2026-09-02T00:00:00.000Z",
          },
          identity: { harness: "codex", threadId: "thread" },
          lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
          metadata: { archived: false, pinned: false, snoozed: false },
          title: "Thread",
        }],
      },
    }),
  });
  assert.equal(result.sidebar.entries.length, 1);
  const entry = result.sidebar.entries[0];
  assert.equal(entry?.entryKind === "thread" && entry.gitArc ? "reloadScopes" in entry.gitArc : true, false);
  assert.equal(diagnostics.length, 1);
});

test("thread-state open repairs a missing project summary during a mixed reload", async () => {
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async () => ({
      catalog: { data: [], rootPath: "C:/projects" },
      project: null,
      sidebar: sidebar(),
    }),
  });
  assert.equal(result.sidebar.projectId, "project");
});

test("thread-state open drops an old project-summary row without rejecting valid sidebar display state", async (context) => {
  const diagnostics = captureTestOutput(context, process.stderr, text => text.startsWith("Repaired Workbench thread-state open response: projectThreads.projects.0."));
  context.after(() => assert.equal(diagnostics.length, 1));
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async () => ({
      catalog: { data: [], rootPath: "C:/projects" },
      project: null,
      projectThreads: {
        projects: [{
          counts: {
            completed: 0,
            needsAttention: 0,
            needsAttentionActive: 0,
            proposedCommit: 0,
            stopped: 0,
            working: 1,
          },
          projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
          revision: 1,
        }],
      },
      sidebar: sidebar(),
    }),
  });
  assert.equal(result.sidebar.projectId, "project");
  assert.deepEqual(result.projectThreads, { projects: [] });
});

test("activity timestamps and activity ordering do not invalidate the root explorer snapshot", () => {
  const current = explorer();
  const activityOnly: ExplorerSnapshot = {
    ...current,
    subagents: [
      { ...current.subagents[1]!, lastActivityAt: 200 },
      { ...current.subagents[0]!, lastActivityAt: 100 },
    ],
    threads: [
      { ...current.threads[1]!, updatedAt: 200 },
      { ...current.threads[0]!, updatedAt: 100 },
    ],
  };

  assert.equal(areExplorerSnapshotsEquivalent(current, activityOnly), true);
});

test("semantic thread and subagent changes invalidate the root explorer snapshot", () => {
  const current = explorer();
  const changedSnapshots: ExplorerSnapshot[] = [
    { ...current, threads: current.threads.slice(1) },
    { ...current, threads: current.threads.map((value, index) => index === 0 ? { ...value, preview: "renamed" } : value) },
    { ...current, threads: current.threads.map((value, index) => index === 0 ? { ...value, status: "idle" } : value) },
    { ...current, subagents: current.subagents.slice(1) },
    { ...current, subagents: current.subagents.map((value, index) => index === 0 ? { ...value, title: "renamed" } : value) },
    { ...current, subagents: current.subagents.map((value, index) => index === 0 ? { ...value, parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("other-parent") } : value) },
    { ...current, subagents: current.subagents.map((value, index) => index === 0 ? { ...value, pinned: true } : value) },
    { ...current, subagents: current.subagents.map((value, index) => index === 0 ? { ...value, lifecycle: { kind: "completed", reason: "providerInactive", settled: false } } : value) },
  ];

  for (const changed of changedSnapshots) {
    assert.equal(areExplorerSnapshotsEquivalent(current, changed), false);
  }
});
