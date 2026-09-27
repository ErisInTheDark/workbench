/*
 * Exports:
 * - No production exports; regression tests protect the explorer/sidebar render boundary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { captureTestOutput } from "../../test/capture-test-output.mts";

import type { ExplorerSnapshot, ThreadSummary, WorkbenchSubagentSummary } from "workbench-shared/types";
import type { PresentationSnapshot } from "workbench-shared/state/workbench-presentation-state";
import type { WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { WorkbenchClient, areExplorerSnapshotsEquivalent, describeGlobalThreadStateOpenFailure, openWorkbenchGlobalThreadStateObservation, openWorkbenchThreadStateObservation } from "./WorkbenchClient.ts";
import { createHomeRoute, createHomeThreadRoute, parseWorkbenchRouteFromPath, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { createLogicalExistingThreadRoute, createLogicalFileRoute, createLogicalProjectRoute, createLogicalThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { appStateClientTables } from "workbench-shared/state/workbench-app-state-schema";
import type ThreadSidebarClient from "./workbench/thread/ThreadSidebarClient";
import WorkbenchClientStateController from "./workbench/state/WorkbenchClientStateController";
import WorkbenchProjectNavigation from "./workbench/navigation/workbench-project-navigation";
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
  configuredDiscoveryRootPath: "C:/repo",
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

for (const order of ["stale-first", "winner-first", "leave-thread", "project-alias", "voice-events", "thread-state-refresh", "server-reload", "reconnect"] as const) {
  const title = order === "server-reload"
    ? "completed server reload clears a vanished selected project"
    : order === "reconnect"
      ? "reconnect clears a vanished project before reopening observations"
      : `route completion never reopens the winning route: ${order}`;
  test(title, async () => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    const originalWebSocket = globalThis.WebSocket;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 404 });
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
    let catalogueActive = true;
    const vanishedProject = Promise.withResolvers<ExplorerSnapshot>();
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
          case "voice/prepare": result = { ok: true }; break;
          case "workbench/daemon/reload-dirt/read": result = { revision: 1, snapshot: { dirtyScopes: [], pendingScopes: [], error: null } }; break;
          case "project/catalog/read":
            result = catalogueActive
              ? { data: [{ id: projectId, kind: "git", name: "repo", relativePath: "web/repo", rootPath, roots, lastCommitTimeMs: null }], rootPath }
              : { data: [], rootPath: "" };
            break;
          case "workbench/thread-state/global/open":
            result = {
              catalog: { data: [], rootPath: "" },
              homeThreadDisplayOrder: { displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder" },
              pinnedThreadLayout: { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" },
              projectSidebars: { projects: [] },
              version: 7,
            };
            break;
          case "workbench/thread-state/open":
            result = {
              catalog: { data: [{ id: projectId, kind: "git", name: "repo", relativePath: "web/repo", rootPath, roots, lastCommitTimeMs: null }], rootPath,
                aliases: order === "project-alias" ? [{ alias: "web/repo", projectId }] : [] },
              project: { projectId, revision: 1, updateKind: "project", snapshot: { projectId, root: "repo", rootPath, roots, changes: {}, tree: [], workbenchStorageRootPath: `${rootPath}/.workbench` } },
              sidebar: { ...sidebar(), projectId, entries },
            };
            break;
          case "workbench/thread-state/refresh":
            result = { ...sidebar(), projectId, entries, revision: 2 };
            break;
          case "thread/identity/resolve": result = { data: { threadId, harness: "codex", projectId } }; break;
          case "thread/reconcile":
            queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
              data: JSON.stringify({ id: request.id, error: { code: -32000, message: "Recovery unavailable in route fixture." } }),
            })));
            return;
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
      client = await WorkbenchClient({
        clientStateController,
        initialRoute: { ...createHomeRoute(), view: "invalid", error: "fixture start" },
        onExplorerStateChange: snapshot => {
          if (!catalogueActive && !snapshot.currentProjectId && snapshot.configuredDiscoveryRootPath === ""
            && snapshot.threads.length === 0) {
            vanishedProject.resolve(snapshot);
          }
        },
      });
      await client.startup.start();
      if (order === "server-reload" || order === "reconnect") {
        const opened = await client.controls.applyRoute({ ...createHomeRoute(), projectId, view: "project" });
        assert.equal(opened.ok, true);
        catalogueActive = false;
        if (order === "server-reload") {
          const notify = (revision: number, pendingScopes: string[]) => {
            for (const socket of sockets) socket.dispatchEvent(new MessageEvent("message", {
              data: JSON.stringify({
                method: "workbench/daemon/reload-dirt/updated",
                params: { revision, snapshot: { dirtyScopes: [], error: null, pendingScopes } },
              }),
            }));
          };
          notify(2, ["server:core"]);
          notify(3, []);
        } else {
          (sockets.at(-1) as Socket).close();
          await client.controls.daemon.projects.catalog();
        }
        const snapshot = await vanishedProject.promise;
        assert.equal(snapshot.currentProjectId, "");
        assert.equal(snapshot.configuredDiscoveryRootPath, "");
        return;
      }
      if (order === "voice-events") {
        await client.controls.daemon.projects.catalog();
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
      if (order === "thread-state-refresh") {
        await (client.threadSidebar as ThreadSidebarClient).open(projectId);
        await client.controls.updateThreadState({ method: "workbench/thread-state/refresh", projectId });
        assert.equal((client.threadSidebar as ThreadSidebarClient).getProjectSnapshot(projectId)?.revision, 2);
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
        const controller = client.getThreadController(projectId, target);
        assert.ok(controller);
        assert.equal(controller.getSnapshot().status, "failed");
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
        if (order === "winner-first") {
          const owner = client.getThreadController(projectId, {
            kind: "provider", harness: "codex",
            threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse(secondId),
          });
          assert.ok(owner, "an attached thread page must remain bound to its controller");
          assert.equal(owner.getSnapshot().status, "ready");
        }
      }
    } finally {
      await (client?.threadSidebar as ThreadSidebarClient | undefined)?.close();
      client?.dispose();
      clientStateController.dispose();
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
      globalThis.WebSocket = originalWebSocket;
      globalThis.fetch = originalFetch;
      if (originalDaemonUrl === undefined) delete process.env.WORKBENCH_CODEX_APP_SERVER_URL;
      else process.env.WORKBENCH_CODEX_APP_SERVER_URL = originalDaemonUrl;
    }
  });
}

test("an old-shape UUID URL keeps its thread owner and the sole browse folder through catalogue updates", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalWebSocket = globalThis.WebSocket;
  const originalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;
  const originalDaemonUrl = process.env.WORKBENCH_CODEX_APP_SERVER_URL;
  const daemonId = fixtureIdentitySchemas.DaemonIdSchema.parse("502902c0-9512-40be-bb06-c65d86ef2029");
  const projectId = fixtureIdentitySchemas.ProjectIdSchema.parse("b597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
  const secondProjectId = fixtureIdentitySchemas.ProjectIdSchema.parse("d597a4b6-7af9-41f1-83ea-a53aed6f3b0a");
  const logicalProjectId = fixtureIdentitySchemas.LogicalProjectIdSchema.parse("112f7e1e-81b6-4c30-bdc0-f83475981001");
  const threadId = fixtureIdentitySchemas.ThreadReferenceSchema.parse(crypto.randomUUID());
  const rootPath = "C:/repo";
  const project = {
    id: projectId, kind: "git" as const, name: "repo", relativePath: "repo", rootPath,
    lastCommitTimeMs: null, roots: [{ id: "repo", isPrimary: true, name: "repo", relativePath: ".", rootPath }],
  };
  const secondProject = { ...project, id: secondProjectId, name: "repo-copy",
    relativePath: "repo-copy", rootPath: "C:/repo-copy",
    roots: [{ id: "repo-copy", isPrimary: true, name: "repo-copy",
      relativePath: ".", rootPath: "C:/repo-copy" }] };
  const catalog = { data: [project], aliases: [], rootPath };
  let catalogAvailable = true;
  let secondAvailable = false;
  let registeredLocationsVisible = true;
  let presentationRevision = 1;
  let storedDraft: PresentationSnapshot["drafts"][number] | null = null;
  const releaseFirstPresentation = Promise.withResolvers<void>();
  let holdFirstPresentation = true;
  const identityKey = "remote://example.test/team/repo";
  const locations = { data: [{ identityKey, rootIdentityKeys: [identityKey], project }] };
  const secondLocation = { identityKey, rootIdentityKeys: [identityKey], project: secondProject };
  const presentation = {
    revision: 1, daemons: [{ id: daemonId, hostname: "desktop" }],
    projects: [{ id: logicalProjectId, matchKey: identityKey, label: "team/repo" }],
    locations: [{ target: { daemonId, projectId }, logicalProjectId, identityKey, name: "repo", rootPath }],
    defaults: [], drafts: [], folders: [], members: [], divergences: [], sourceMappings: [],
  };
  const rows = Object.fromEntries(Object.keys(appStateClientTables).map(name => [name, []]));
  const requests: string[] = [];
  const network = {
    configuration: {
      mode: "localhost", hostServe: { enabled: false, port: 8080 }, members: [],
      privateAccess: { role: "authority", label: "desktop", enabled: false },
    },
    runtime: {
      hostServe: { phase: "ready", message: null, url: null },
      privateAccess: {
        phase: "ready", message: null, url: null, hostname: null, nodeId: null,
        keyFingerprint: null, loginUrl: null, addresses: [], rootCertificate: null,
        rootFingerprint: null, certificateExpiresAt: null, pending: [],
      },
    },
    executable: { available: true, message: null }, hostPlatform: "win32",
    busy: false, failure: null,
    daemon: { protocol: 1, daemonId, hostname: "desktop", state: "ready", wakeEnabled: true },
  };
  class Socket extends EventTarget {
    static OPEN = 1;
    static latest: Socket | null = null;
    readyState = 1;
    readonly closed = Promise.withResolvers<void>();
    constructor() {
      super();
      Socket.latest = this;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
      this.closed.resolve();
    }
    send(raw: string) {
      const request = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, unknown> };
      if (request.id === undefined) return;
      requests.push(request.method);
      const params = request.params ?? {};
      const entry = {
        entryKind: "thread", title: "thread", activityAt: 1,
        identity: { harness: "codex", threadId },
        metadata: { archived: false, pinned: false, snoozed: false },
        lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      };
      const result = request.method === "initialize" ? {}
        : request.method === "voice/configuration/read" ? { selection: null }
        : request.method === "voice/prepare" ? { ok: true }
        : request.method === "project/catalog/read" ? catalogAvailable
          ? { ...catalog, data: secondAvailable ? [project, secondProject] : [project] }
          : { data: [], aliases: [], rootPath }
        : request.method === "project/locations/read" ? catalogAvailable
          ? { data: secondAvailable ? [...locations.data, secondLocation] : locations.data }
          : { data: [] }
        : request.method === "project/file-index/read" ? {
          projectId, key: "one-file", candidates: [{ path: "src/a.md", isIgnored: false }],
        }
        : request.method === "thread/presentation/layout/read" ? (() => {
          const value = params.scope === "project" ? { displayOrder: {} } : {};
          const bytes = Buffer.from(JSON.stringify(value));
          return { sourceRevision: 0, bytes: bytes.toString("base64"),
            totalBytes: bytes.length, nextOffset: null };
        })()
        : request.method === "workbench/daemon/reload-dirt/read" ? { revision: 1, snapshot: { dirtyScopes: [], pendingScopes: [], error: null } }
        : request.method === "workbench/thread-state/global/open" ? {
          version: 7, catalog,
          homeThreadDisplayOrder: { displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder" },
          pinnedThreadLayout: { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" },
          projectSidebars: { projects: [{ entries: [entry], error: null, freshness: "fresh", projectId, revision: 1 }] },
        }
        : request.method === "workbench/thread-state/open" ? {
          catalog,
          project: { projectId, revision: 1, updateKind: "project",
            snapshot: { projectId, root: "repo", rootPath, roots: project.roots,
              changes: {}, tree: [], workbenchStorageRootPath: `${rootPath}/.workbench` } },
          sidebar: { entries: [entry], error: null, freshness: "fresh", projectId, revision: 1 },
        }
        : request.method === "workbench/thread-state/observe" ? {
          observation: {
            ...params, entries: [entry], revision: 1, freshness: "fresh", error: null,
            updateKind: "threadObservation",
          },
        }
        : request.method === "thread/identity/resolve" ? { data: params.threadId === "missing-target" ? null : {
          threadId: String(params.threadId), harness: "codex", projectId,
        } }
        : request.method === "thread/page/read" ? {
          thread: {
            ...thread(threadId, 1), cwd: rootPath, turns: [{
              completedAt: null, durationMs: null, error: null, id: "turn",
              items: [], itemsView: "full", startedAt: 1, status: "inProgress",
            }], turnHistory: [],
            isDraft: false, model: null, reasoningEffort: null, serviceTier: null, agentPath: null, tokenUsage: null,
          },
          nextCursor: null, browseResultEntries: [], questionnaireEntries: [], steerEntries: [],
        }
        : request.method === "thread/message/submit" ? { kind: "steered", turnId: "turn" }
        : request.method === "workbench/thread-state/snooze/until" ? { accepted: true, revision: 1 }
        : request.method === "thread/reconcile" ? { turnIds: [], exhausted: false }
        : request.method === "account/limits/read" ? {
          rateLimits: { limitId: null, limitName: null, primary: null, secondary: null, credits: null, planType: null },
          rateLimitsByLimitId: null,
        }
        : request.method === "models/list" ? { data: [{
          id: "test-model", displayName: "Test model", description: "", hidden: false, isDefault: true,
          supportsPersonality: false, supportsReasoningEffort: false, supportedReasoningEfforts: [],
          defaultReasoningEffort: null, supportsVision: false, supportsFastMode: false,
          inputModalities: ["text"], maxContextWindowTokens: null, additionalSpeedTiers: [],
          policyState: null, billingMultiplier: null,
        }] }
        : request.method === "thread/launch" ? {
          phase: "accepted", launchId: params.launchId, threadId, turnId: "turn",
        }
        : { accepted: true, data: [] };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ id: request.id, result }),
      })));
    }
  }
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const appStateUrl = new URL(url, "http://workbench.test");
    if (appStateUrl.pathname === "/api/workbench-client-state"
      && appStateUrl.searchParams.get("capabilities") === "3") return Response.json({
      kind: "snapshot", daemonRegistrationId: "attached-registration",
      registrations: [{ id: "attached-registration", kind: "local", daemonId }],
      oldestAvailableRevision: 0, revision: 1, schemaVersion: 1, rows,
    });
    if (url.startsWith("/api/workbench-network")) return Response.json(network);
    if (url.startsWith("/api/workbench-presentation")) {
      if (url.endsWith("/mutate") && storedDraft) {
        const mutation = JSON.parse(String(init?.body)) as {
          kind: string;
          draft?: Partial<typeof storedDraft>;
          launchId?: string;
          threadId?: string;
        };
        if (mutation.kind === "putDraft" && mutation.draft) {
          storedDraft = { ...storedDraft, ...mutation.draft, revision: ++presentationRevision };
        }
        if (mutation.kind === "reserveLaunch" && mutation.launchId) {
          storedDraft = {
            ...storedDraft, phase: "submitting", launchId: mutation.launchId,
            revision: ++presentationRevision,
          };
        }
        if (mutation.kind === "completeLaunch" && mutation.threadId) {
          storedDraft = {
            ...storedDraft, phase: "accepted", acceptedThreadId: mutation.threadId,
            revision: ++presentationRevision,
          };
        }
      }
      if (holdFirstPresentation) {
        holdFirstPresentation = false;
        await releaseFirstPresentation.promise;
      }
      return Response.json({
        ...presentation, revision: presentationRevision,
        drafts: storedDraft ? [storedDraft] : [],
        locations: !registeredLocationsVisible ? [] : secondAvailable ? [...presentation.locations, {
          target: { daemonId, projectId: secondProjectId }, logicalProjectId, identityKey,
          name: "repo-copy", rootPath: "C:/repo-copy",
        }] : presentation.locations,
      });
    }
    return new Response(null, { status: 404 });
  };
  class NetworkEvents {
    static latest: NetworkEvents | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { NetworkEvents.latest = this; }
    close() {}
  }
  globalThis.EventSource = NetworkEvents as unknown as typeof EventSource;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.document = new EventTarget() as Document;
  globalThis.window = {
    location: { href: "http://workbench.test/", origin: "http://workbench.test" },
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => setImmediate(() => callback(performance.now())),
    cancelAnimationFrame: clearImmediate,
  } as unknown as Window & typeof globalThis;
  process.env.WORKBENCH_CODEX_APP_SERVER_URL = "ws://workbench.test";
  const clientStateController = new WorkbenchClientStateController({
    mode: "http", visibility: { hidden: () => true, subscribe: () => () => {} },
  });
  const explorerSnapshots: ExplorerSnapshot[] = [];
  let observeBrowse: ((snapshot: ExplorerSnapshot) => void) | null = null;
  let client: Awaited<ReturnType<typeof WorkbenchClient>> | undefined;
  try {
    await clientStateController.bootstrap();
    const route = createLogicalExistingThreadRoute(logicalProjectId,
      { kind: "provider", threadId });
    client = WorkbenchClient({ clientStateController,
      onExplorerStateChange: snapshot => { explorerSnapshots.push(snapshot); observeBrowse?.(snapshot); },
      initialRoute: parseWorkbenchRouteFromPath(`/repo/@/thread/${threadId}`) });
    assert.equal(client.startup.getSnapshot().phase, "loading",
      "a pending presentation read must not prevent client construction");
    assert.equal(requests.filter(method => method === "thread/page/read").length, 0,
      "mount must not open the initial URL before the URL intent adapter applies it");
    const presentationReady = Promise.withResolvers<void>();
    const unsubscribePresentation = client.presentationClient?.subscribe(() => {
      if (client?.presentationClient?.snapshot().data) presentationReady.resolve();
    });
    const admittedRoute = Promise.withResolvers<void>();
    const unsubscribeRoute = client.navigation.subscribe(() => {
      const selected = client?.navigation.getSnapshot();
      if (selected?.phase === "ready" && selected.route.view === "thread"
        && selected.route.threadId === threadId) admittedRoute.resolve();
    });
    client.routeIntents.request(route);
    releaseFirstPresentation.resolve();
    await Promise.all([client.startup.start(), presentationReady.promise]);
    await admittedRoute.promise;
    unsubscribePresentation?.();
    unsubscribeRoute();
    const legacyNew = await client.controls.applyRoute(createHomeThreadRoute(projectId, { kind: "new" }));
    assert.equal(legacyNew.ok, false, "app-owned drafts cannot be created through a daemon sidebar route");
    assert.equal((await client.controls.applyRoute(route)).ok, true);
    const beforeWait = requests.length;
    await assert.rejects(client.controls.threadAction(
      fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId),
      { kind: "snoozeUntil", targetThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("missing-target") },
    ), /unavailable/i);
    assert.equal(requests.slice(beforeWait).includes("workbench/thread-state/settle"), false);
    assert.equal(await client.controls.threadAction(
      fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId),
      { kind: "snoozeUntil", targetThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    ), true);
    assert.equal(requests.slice(beforeWait).includes("workbench/thread-state/snooze/until"), true);
    assert.equal(requests.includes("thread/presentation/export"), false,
      "opening a thread must not trigger an eager legacy export");
    assert.equal(client.threadRuntime.getSnapshot().currentThread?.id, threadId,
      `initial route did not read the thread: ${requests.join(", ")}`);
    const combined = await client.controls.applyRoute(createLogicalProjectRoute(logicalProjectId));
    assert.equal(combined.ok, true, combined.error ?? "combined project route did not open");
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.equal(explorerSnapshots.at(-1)?.currentProjectId, projectId);
    assert.equal(explorerSnapshots.at(-1)?.logicalThreads?.length, 1);
    assert.deepEqual(explorerSnapshots.at(-1)?.browseLocation, { daemonId, projectId });
    catalogAvailable = false;
    await client.controls.refreshProjectCatalog();
    assert.equal(explorerSnapshots.at(-1)?.logicalProjects?.[0]?.locations[0]?.project, null);
    await client.controls.applyRoute(createHomeRoute());
    catalogAvailable = true;
    const recovered = await client.controls.applyRoute(createLogicalProjectRoute(logicalProjectId));
    assert.equal(recovered.ok, true, recovered.error ?? "registered folder route did not open");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(explorerSnapshots.at(-1)?.currentProjectId, projectId,
      "a sole registered folder must be validated and selected when its catalogue arrives");
    assert.deepEqual(explorerSnapshots.at(-1)?.browseLocation, { daemonId, projectId });
    const multiple = Promise.withResolvers<void>();
    observeBrowse = snapshot => {
      if (snapshot.logicalProjects?.[0]?.locations.filter(item => item.project).length === 2
        && snapshot.browseLocation === null) multiple.resolve();
    };
    secondAvailable = true;
    presentationRevision += 1;
    await client.controls.refreshProjectCatalog();
    await client.presentationClient?.refresh();
    await multiple.promise;
    const homeThread = await client.controls.applyRoute(createLogicalExistingThreadRoute(null,
      { kind: "provider", threadId }));
    assert.equal(homeThread.ok, true, homeThread.error ?? "home thread did not open");
    assert.equal(explorerSnapshots.at(-1)?.browseLocation, null);
    const soleAgain = Promise.withResolvers<void>();
    observeBrowse = snapshot => {
      if (snapshot.logicalProjects?.[0]?.locations.filter(item => item.project).length === 1
        && snapshot.browseLocation === null) soleAgain.resolve();
    };
    secondAvailable = false;
    presentationRevision += 1;
    await client.controls.refreshProjectCatalog();
    await client.presentationClient?.refresh();
    await soleAgain.promise;
    assert.equal(explorerSnapshots.at(-1)?.currentProjectId, "",
      "a Home thread never selects its sole launch folder for browsing");
    observeBrowse = null;
    const file = await client.controls.applyRoute(createLogicalFileRoute(logicalProjectId, null, "src/a.md"));
    assert.equal(file.ok, true, file.error ?? "single-folder file route did not select its browse owner");
    await new Promise<void>(resolve => queueMicrotask(resolve));
    assert.deepEqual(explorerSnapshots.at(-1)?.browseLocation, { daemonId, projectId });
    const home = await client.controls.applyRoute(createHomeRoute());
    assert.equal(home.ok, true, home.error ?? "home route did not complete");
    assert.ok(client.projectFileIndexStore);
    assert.deepEqual((await client.projectFileIndexStore.ensure({ daemonId, projectId })).paths, ["src/a.md"]);
    assert.equal(explorerSnapshots.at(-1)?.browseLocation, null);
    let homeRuntimePublications = 0;
    const stopHomeRuntime = client.threadRuntime.subscribe(() => { homeRuntimePublications += 1; });
    Socket.latest?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      method: "workbench/thread-state/updated",
      params: { updateKind: "pinnedThreadLayout", revision: 2, displayOrder: {} },
      workbenchHarness: "workbench",
    }) }));
    assert.equal(homeRuntimePublications, 0,
      "a global layout update must not reset the projectless selected-thread runtime");
    stopHomeRuntime();
    await client.controls.refreshRateLimits();
    const rateReadsBeforeReopen = requests.filter(method => method === "account/limits/read").length;
    const reopened = await client.controls.applyRoute(route);
    assert.equal(reopened.ok, true, reopened.error ?? requests.join(", "));
    assert.equal(requests.filter(method => method === "account/limits/read").length, rateReadsBeforeReopen,
      "returning to a thread on the same daemon should reuse freshly read account limits");
    const controller = client.getThreadController(projectId, { kind: "provider", threadId });
    assert.ok(controller, "the mounted UUID route must expose its concrete thread owner");
    assert.equal(client.threadRuntime.getSnapshot().currentThread?.id, threadId, requests.join(", "));
    assert.equal(controller.getSnapshot().status, "ready");
    assert.equal(controller.getSnapshot().document?.id, threadId);
    assert.deepEqual(client.threadDraftIdentityFor(threadId), {
      daemonRegistrationId: "attached-registration", projectId, threadId,
    });
    const selectedThread = client.threadRuntime.getSnapshot().currentThread!;
    if (selectedThread.isDraft) throw new Error("The active UUID route must select an admitted thread.");
    await client.controls.refreshProjectCatalog();
    assert.equal(client.threadRuntime.getSnapshot().currentThread?.id, threadId);
    await assert.rejects(client.controls.sendThreadMessage({
      ...selectedThread, id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("wrong-thread"),
    }, [{ text: "wrong owner", text_elements: [], type: "text" }]));
    assert.equal(requests.filter(method => method === "thread/message/submit").length, 0);
    await client.controls.applyRoute(createLogicalProjectRoute(logicalProjectId));
    await assert.rejects(client.controls.sendThreadMessage(selectedThread, [{
      text: "left thread", text_elements: [], type: "text",
    }]));
    assert.equal(requests.filter(method => method === "thread/message/submit").length, 0);
    assert.equal((await client.controls.applyRoute(route)).ok, true);
    await client.controls.sendThreadMessage(selectedThread, [{
      text: "active steer", text_elements: [], type: "text",
    }]);
    assert.equal(requests.filter(method => method === "thread/message/submit").length, 1);
    catalogAvailable = false;
    await client.controls.refreshProjectCatalog();
    const missing = await client.controls.applyRoute(createLogicalExistingThreadRoute(logicalProjectId, {
      kind: "provider", threadId: fixtureIdentitySchemas.ThreadReferenceSchema.parse(crypto.randomUUID()),
    }));
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /unavailable/iu);
    catalogAvailable = true;
    const firstSocket = Socket.latest;
    client.dispose();
    await firstSocket?.closed.promise;
    client = await WorkbenchClient({ clientStateController,
      onExplorerStateChange: snapshot => { explorerSnapshots.push(snapshot); },
      initialRoute: {
      ...createHomeRoute(), projectId, view: "thread", threadId,
      threadTarget: { kind: "provider", threadId, harness: "codex" },
    } });
    await client.startup.start();
    assert.equal((await client.controls.applyRoute({
      ...createHomeRoute(), projectId, view: "thread", threadId,
      threadTarget: { kind: "provider", threadId, harness: "codex" },
    })).ok, true);
    assert.equal(client.threadRuntime.getSnapshot().currentThread?.id, threadId, requests.join(", "));
    assert.deepEqual(client.threadDraftIdentityFor(threadId), {
      daemonRegistrationId: "attached-registration", projectId, threadId,
    });
    const oldUrlThread = client.threadRuntime.getSnapshot().currentThread!;
    if (oldUrlThread.isDraft) throw new Error("The old URL must open an existing thread.");
    const sendsBeforeOldUrl = requests.filter(method => method === "thread/message/submit").length;
    await client.controls.sendThreadMessage(oldUrlThread, [{
      text: "old URL steer", text_elements: [], type: "text",
    }]);
    assert.equal(requests.filter(method => method === "thread/message/submit").length, sendsBeforeOldUrl + 1);
    const publicNavigation = new WorkbenchProjectNavigation(
      [project], [], explorerSnapshots.at(-1)?.logicalProjects ?? [],
    );
    const fromUrl = (route: WorkbenchRoute) => {
      const href = publicNavigation.href(route);
      assert.ok(href);
      return publicNavigation.readRoute(href);
    };
    const freshRoute = fromUrl(createLogicalThreadRoute(
      null, logicalProjectId, { daemonId, projectId }, { kind: "new" },
    ));
    assert.equal(freshRoute.logical?.location, null);
    assert.equal((await client.controls.applyRoute(freshRoute)).ok, true);
    assert.equal(explorerSnapshots.at(-1)?.currentProjectId, "",
      "a Home draft's launch folder must not become the viewed project");
    assert.equal(explorerSnapshots.at(-1)?.browseLocation, null);
    secondAvailable = true;
    presentationRevision += 1;
    await client.controls.refreshProjectCatalog();
    await client.presentationClient?.refresh();
    const secondFolderRoute = createLogicalThreadRoute(null, logicalProjectId,
      { daemonId, projectId: secondProjectId }, { kind: "new" });
    assert.equal((await client.controls.applyRoute(secondFolderRoute)).ok, true);
    const secondFolderDraft = client.threadRuntime.getSnapshot().currentThread;
    assert.ok(secondFolderDraft?.isDraft);
    assert.deepEqual(client.draftLocationFor(secondFolderDraft.id), { daemonId, projectId: secondProjectId },
      "one folder choice must move the draft's execution location, not only its route");
    assert.equal((await client.controls.applyRoute(createLogicalThreadRoute(null, logicalProjectId,
      { daemonId, projectId }, { kind: "new" }))).ok, true);
    const firstFolderDraft = client.threadRuntime.getSnapshot().currentThread;
    assert.ok(firstFolderDraft?.isDraft);
    assert.deepEqual(client.draftLocationFor(firstFolderDraft.id), { daemonId, projectId });
    secondAvailable = false;
    presentationRevision += 1;
    await client.controls.refreshProjectCatalog();
    await client.presentationClient?.refresh();
    const editingDraft = client.threadRuntime.getSnapshot().currentThread;
    assert.ok(editingDraft?.isDraft);
    storedDraft = {
      id: fixtureIdentitySchemas.DraftIdSchema.parse(editingDraft.id),
      logicalProjectId, target: { daemonId, projectId }, prompt: "a saved draft",
      selection: { kind: "custom", settings: {
        agentPath: null, agentSource: null, harness: "codex", model: "",
        reasoningEffort: null, serviceTier: null, contextWindowTokens: null,
      } },
      updatedAt: 2, revision: presentationRevision + 1, phase: "unsent",
      pinned: false, snoozed: false, launchId: null, acceptedThreadId: null, attachments: [],
    };
    presentationRevision += 1;
    await client.presentationClient?.refresh();
    const savedRoute = fromUrl(createLogicalThreadRoute(null, logicalProjectId, null,
      { kind: "draft", draftId: fixtureIdentitySchemas.DraftIdSchema.parse(storedDraft.id) }));
    assert.equal(savedRoute.logical?.location, null);
    const phases: string[] = [];
    const stopRoutePhases = client.navigation.subscribe(() => {
      phases.push(client!.navigation.getSnapshot().phase);
    });
    assert.equal((await client.controls.applyRoute(savedRoute)).ok, true);
    stopRoutePhases();
    assert.equal(phases.includes("loading"), false,
      "saving a draft does not put its existing editor back into route loading");
    assert.strictEqual(client.threadRuntime.getSnapshot().currentThread, editingDraft,
      "saving a draft refines its route without creating another editor session");
    storedDraft = { ...storedDraft, phase: "deleted", revision: presentationRevision + 1 };
    presentationRevision += 1;
    await client.presentationClient?.refresh();
    const clearingPhases: string[] = [];
    const stopClearingPhases = client.navigation.subscribe(() => {
      clearingPhases.push(client!.navigation.getSnapshot().phase);
    });
    assert.equal((await client.controls.applyRoute(freshRoute)).ok, true);
    stopClearingPhases();
    assert.equal(clearingPhases.includes("loading"), false);
    assert.strictEqual(client.threadRuntime.getSnapshot().currentThread, editingDraft);
    assert.equal(client.navigation.getSnapshot().phase, "ready");
    assert.equal((await client.controls.applyRoute(createHomeRoute())).ok, true);
    assert.equal(client.draftLocationFor(editingDraft.id), null,
      "leaving the empty composer retires its transient session owner");
    registeredLocationsVisible = false;
    presentationRevision += 1;
    await client.presentationClient?.refresh();
    const observedOnly = await client.controls.applyRoute(createLogicalExistingThreadRoute(logicalProjectId, {
      kind: "provider", threadId,
    }));
    assert.equal(observedOnly.ok, true,
      observedOnly.error ?? "an observed thread should open before its presentation location is stored");
    registeredLocationsVisible = true;
    storedDraft = {
      ...storedDraft!, phase: "unsent", launchId: null, acceptedThreadId: null,
      revision: ++presentationRevision,
    };
    await client.presentationClient?.refresh();
    const launchDraftId = fixtureIdentitySchemas.DraftIdSchema.parse(storedDraft.id);
    const launchRoute = createLogicalThreadRoute(null, logicalProjectId, null, {
      kind: "draft", draftId: launchDraftId,
    });
    assert.equal((await client.controls.applyRoute(launchRoute)).ok, true);
    const launchDraft = client.threadRuntime.getSnapshot().currentThread;
    assert.ok(launchDraft?.isDraft);
    const otherDaemonId = fixtureIdentitySchemas.DaemonIdSchema.parse("f8b969e9-25d9-4d50-981c-0d75a151e56b");
    NetworkEvents.latest?.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ ...network, daemon: { ...network.daemon, daemonId: otherDaemonId } }),
    }));
    assert.equal(client.networkClient?.snapshot().snapshot?.daemon?.daemonId, otherDaemonId);
    const modelReadsBeforeMismatch = requests.filter(method => method === "models/list").length;
    await assert.rejects(client.controls.retargetPresentationDraft(launchDraftId, { daemonId, projectId }));
    assert.equal(requests.filter(method => method === "models/list").length, modelReadsBeforeMismatch,
      "a conflicting network identity must not send the draft to the attached daemon");
    NetworkEvents.latest?.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ ...network, daemon: undefined }),
    }));
    assert.equal(client.networkClient?.snapshot().snapshot?.daemon, undefined);
    await client.controls.retargetPresentationDraft(launchDraftId, { daemonId, projectId });
    const launched = await client.controls.sendThreadMessage(launchDraft, [{
      text: "start local thread", text_elements: [], type: "text",
    }]);
    assert.equal(launched?.id, threadId);
    assert.equal(requests.filter(method => method === "thread/launch").length, 1);
  } finally {
    releaseFirstPresentation.resolve();
    const lastSocket = Socket.latest;
    client?.dispose();
    await lastSocket?.closed.promise;
    clientStateController.dispose();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.WebSocket = originalWebSocket;
    globalThis.EventSource = originalEventSource;
    globalThis.fetch = originalFetch;
    if (originalDaemonUrl === undefined) delete process.env.WORKBENCH_CODEX_APP_SERVER_URL;
    else process.env.WORKBENCH_CODEX_APP_SERVER_URL = originalDaemonUrl;
  }
});

test("thread-state open negotiates incremental delivery with a complete bootstrap", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 | 6 | 7 }> = [];
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
  assert.deepEqual(requests, [{ projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 7 }]);
  assert.equal(result.sidebar.projectId, "project");
  assert.deepEqual(result.pinnedThreadLayout, {
    displayOrder: {},
    revision: 0,
    updateKind: "pinnedThreadLayout",
  });
  assert.deepEqual(result.projectThreads, { projects: [] });
  assert.equal(catalogs.length, 1);
});

test("thread-state open falls back to the prior protocol for old servers", async () => {
  const versions: number[] = [];
  await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    request: async ({ version }) => {
      versions.push(version ?? 0);
      if (version === 7) throw new WorkbenchDaemonRequestError(
        "Invalid literal value, expected 6",
        "invalidThreadStateMutation" as never,
      );
      return { catalog: { data: [], rootPath: "C:/projects" }, project: null, sidebar: sidebar() };
    },
  });
  assert.deepEqual(versions, [7, 6]);
});

test("global thread-state open installs a catalog and full sidebars without a selected project snapshot", async () => {
  const catalogs: unknown[] = [];
  const versions: Array<4 | 5 | 6 | 7 | 8 | 9> = [];
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
        version: 9,
      };
    },
  });
  assert.deepEqual(versions, [9]);
  assert.deepEqual(catalogs, [{ data: [], aliases: [], rootPath: "C:/projects" }]);
  assert.deepEqual(result.projectSidebars.projects.map(({ projectId }) => projectId), ["alpha", "beta"]);
  assert.equal(result.homeThreadDisplayOrder?.revision, 2);
  assert.equal("project" in result, false);
});

test("global thread-state open falls back to read-only version 4 only for an old protocol rejection", async () => {
  const versions: Array<4 | 5 | 6 | 7 | 8 | 9> = [];
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
  assert.deepEqual(versions, [9, 8, 7, 6, 5, 4]);
  assert.equal(result.homeThreadDisplayOrder, null);
});

test("global thread-state open preserves version 5 home ordering during a mixed reload", async () => {
  const versions: Array<4 | 5 | 6 | 7 | 8 | 9> = [];
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
  assert.deepEqual(versions, [9, 8, 7, 6, 5]);
  assert.equal(result.homeThreadDisplayOrder?.revision, 7);
});

test("global thread-state failures retain the actual server error and request boundary", () => {
  assert.equal(
    describeGlobalThreadStateOpenFailure(new Error("storage read failed")),
    "Unable to open all-project threads through workbench/thread-state/global/open: storage read failed",
  );
});

test("thread-state open negotiates back to version 2 while the server is still old", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 | 6 | 7 }> = [];
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
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 7 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 6 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 5 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 4 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 3 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 2 },
  ]);
  assert.equal(result.sidebar.projectId, "project");
  assert.deepEqual(result.projectThreads, { projects: [] });
});

test("thread-state open falls back from version 4 on the typed old-server rejection", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 | 6 | 7 }> = [];
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
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 7 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 6 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 5 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 4 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 3 },
  ]);
  assert.equal(result.sidebar.projectId, "project");
});

test("thread-state open retries legacy only for an unsupported version field", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 | 6 | 7 }> = [];
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
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 7 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 6 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 5 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 4 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 3 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 2 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") },
  ]);
  assert.equal(result.sidebar.projectId, "project");
});

test("thread-state open accepts a composite bootstrap from the versionless compatibility retry", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 | 4 | 5 | 6 | 7 }> = [];
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
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 7 },
    { projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), version: 6 },
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
    { ...current, configuredDiscoveryRootPath: "" },
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
