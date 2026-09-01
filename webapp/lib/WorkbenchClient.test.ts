/*
 * Exports:
 * - No production exports; regression tests protect the explorer/sidebar render boundary. Keywords: explorer, sidebar, equality, React.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExplorerSnapshot, ThreadSummary, WorkbenchSubagentSummary } from "./types.ts";
import type { WorkbenchThreadSidebarSnapshot } from "./workbench/thread/thread-state.ts";
import { WorkbenchDaemonRequestError } from "./workbench/daemon/WorkbenchDaemonClient.ts";
import { areExplorerSnapshotsEquivalent, describeGlobalThreadStateOpenFailure, openWorkbenchGlobalThreadStateObservation, openWorkbenchThreadStateObservation, requestWorkbenchReload } from "./WorkbenchClient.ts";

const thread = (id: string, updatedAt: number): ThreadSummary => ({
  agentNickname: null,
  agentRole: null,
  createdAt: 1,
  cwd: "C:/repo",
  forkedFromId: null,
  harness: "codex",
  id,
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
  lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
  name: threadId,
  parentThreadId: "parent",
  pinned: false,
  profileId: "profile",
  profileName: "Profile",
  projectId: "project",
  threadId,
  title: threadId,
  updatedAt: 1,
});

const explorer = (): ExplorerSnapshot => ({
  changes: {},
  currentPath: "",
  currentProjectId: "project",
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
  entries: [], error: null, freshness: "fresh", projectId: "project", revision: 1,
});

test("thread-state open keeps an old version-3 response available during a mixed reload", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 }> = [];
  const catalogs: unknown[] = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: (catalog) => { catalogs.push(catalog); },
    projectId: "project",
    request: async (params) => {
      requests.push(params);
      return { catalog: { data: [], rootPath: "C:/projects" }, project: null, sidebar: sidebar() };
    },
  });
  assert.deepEqual(requests, [{ projectId: "project", version: 3 }]);
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
  const versions: Array<4 | 5> = [];
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
            { ...sidebar(), projectId: "alpha" },
            { ...sidebar(), projectId: "beta" },
          ],
        },
        version: 5,
      };
    },
  });
  assert.deepEqual(versions, [5]);
  assert.deepEqual(catalogs, [{ data: [], rootPath: "C:/projects" }]);
  assert.deepEqual(result.projectSidebars.projects.map(({ projectId }) => projectId), ["alpha", "beta"]);
  assert.equal(result.homeThreadDisplayOrder?.revision, 2);
  assert.equal("project" in result, false);
});

test("global thread-state open falls back to read-only version 4 only for an old protocol rejection", async () => {
  const versions: Array<4 | 5> = [];
  const result = await openWorkbenchGlobalThreadStateObservation({
    installCatalog: () => undefined,
    request: async (version) => {
      versions.push(version);
      if (version === 5) throw new WorkbenchDaemonRequestError(
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
  assert.deepEqual(versions, [5, 4]);
  assert.equal(result.homeThreadDisplayOrder, null);
});

test("global thread-state failures retain the actual server error and request boundary", () => {
  assert.equal(
    describeGlobalThreadStateOpenFailure(new Error("storage read failed")),
    "Unable to open all-project threads through workbench/thread-state/global/open: storage read failed",
  );
});

test("browser reload uses the shared socket method and conforms its admission", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const result = await requestWorkbenchReload(["server:database"], async (method, params) => {
    requests.push({ method, params });
    return {
      appliedScopes: [], completedAt: null, error: null, ok: true,
      queuedScopes: ["server:database"], requestedScopes: ["server:database"],
      startedAt: 1, state: "running",
    };
  });
  assert.deepEqual(requests, [{
    method: "workbench/orchestrator/reload",
    params: { scopes: ["server:database"] },
  }]);
  assert.equal(result.state, "running");
});

test("thread-state open negotiates back to version 2 while the server is still old", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 }> = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: "project",
    request: async (params) => {
      requests.push(params);
      if (params.version === 3) throw new Error("Invalid input: expected 2");
      return {
        catalog: { data: [], rootPath: "C:/projects" },
        project: null,
        projectThreads: { projects: [] },
        sidebar: sidebar(),
      };
    },
  });
  assert.deepEqual(requests, [
    { projectId: "project", version: 3 },
    { projectId: "project", version: 2 },
  ]);
  assert.equal(result.sidebar.projectId, "project");
  assert.deepEqual(result.projectThreads, { projects: [] });
});

test("thread-state open retries legacy only for an unsupported version field", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 }> = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: "project",
    request: async (params) => {
      requests.push(params);
      if (params.version !== undefined) throw new Error('Unrecognized key: "version"');
      return sidebar();
    },
  });
  assert.deepEqual(requests, [
    { projectId: "project", version: 3 },
    { projectId: "project", version: 2 },
    { projectId: "project" },
  ]);
  assert.equal(result.sidebar.projectId, "project");
});

test("thread-state open accepts a composite bootstrap from the versionless compatibility retry", async () => {
  const requests: Array<{ projectId: string; version?: 2 | 3 }> = [];
  const catalogs: unknown[] = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: (catalog) => { catalogs.push(catalog); },
    projectId: "project",
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
    { projectId: "project", version: 3 },
    { projectId: "project", version: 2 },
    { projectId: "project" },
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
    projectId: "project",
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
  assert.deepEqual(catalogs, [{ data: [], rootPath: "C:/projects" }]);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0]!, /Repaired Workbench thread-state open response/u);
});

test("thread-state open repairs a missing project summary during a mixed reload", async () => {
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: "project",
    request: async () => ({
      catalog: { data: [], rootPath: "C:/projects" },
      project: null,
      sidebar: sidebar(),
    }),
  });
  assert.equal(result.sidebar.projectId, "project");
});

test("thread-state open drops an old project-summary row without rejecting valid sidebar display state", async () => {
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: "project",
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
          projectId: "project",
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
    { ...current, subagents: current.subagents.map((value, index) => index === 0 ? { ...value, parentThreadId: "other-parent" } : value) },
    { ...current, subagents: current.subagents.map((value, index) => index === 0 ? { ...value, pinned: true } : value) },
    { ...current, subagents: current.subagents.map((value, index) => index === 0 ? { ...value, lifecycle: { kind: "completed", reason: "providerInactive", settled: false } } : value) },
  ];

  for (const changed of changedSnapshots) {
    assert.equal(areExplorerSnapshotsEquivalent(current, changed), false);
  }
});
