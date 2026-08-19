/*
 * Exports:
 * - No production exports; regression tests protect the explorer/sidebar render boundary. Keywords: explorer, sidebar, equality, React.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExplorerSnapshot, ThreadSummary, WorkbenchSubagentSummary } from "./types.ts";
import type { WorkbenchThreadSidebarSnapshot } from "./workbench/thread/thread-state.ts";
import { areExplorerSnapshotsEquivalent, openWorkbenchThreadStateObservation } from "./WorkbenchClient.ts";

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

test("thread-state open installs the version-2 composite bootstrap", async () => {
  const requests: Array<{ projectId: string; version?: 2 }> = [];
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
  assert.deepEqual(requests, [{ projectId: "project", version: 2 }]);
  assert.equal(result.projectId, "project");
  assert.equal(catalogs.length, 1);
});

test("thread-state open retries legacy only for an unsupported version field", async () => {
  const requests: Array<{ projectId: string; version?: 2 }> = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: "project",
    request: async (params) => {
      requests.push(params);
      if (params.version === 2) throw new Error('Unrecognized key: "version"');
      return sidebar();
    },
  });
  assert.deepEqual(requests, [{ projectId: "project", version: 2 }, { projectId: "project" }]);
  assert.equal(result.projectId, "project");
});

test("thread-state open accepts a composite bootstrap from the versionless compatibility retry", async () => {
  const requests: Array<{ projectId: string; version?: 2 }> = [];
  const catalogs: unknown[] = [];
  const result = await openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: (catalog) => { catalogs.push(catalog); },
    projectId: "project",
    request: async (params) => {
      requests.push(params);
      if (params.version === 2) throw new Error('Unrecognized key: "version"');
      return { catalog: { data: [], rootPath: "C:/projects" }, project: null, sidebar: sidebar() };
    },
  });
  assert.deepEqual(requests, [{ projectId: "project", version: 2 }, { projectId: "project" }]);
  assert.equal(result.projectId, "project");
  assert.equal(catalogs.length, 1);
});

test("thread-state open does not hide malformed version-2 payloads behind legacy fallback", async () => {
  let requests = 0;
  await assert.rejects(openWorkbenchThreadStateObservation({
    acceptProject: () => undefined,
    installCatalog: () => undefined,
    projectId: "project",
    request: async () => { requests += 1; return { sidebar: sidebar() }; },
  }), /thread-state open response was invalid/u);
  assert.equal(requests, 1);
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
