/* No production exports. Tests protect headless ownership, pushed reload dirt, folder persistence, MCP generation, observation replay, reconciliation, mutations, and stale publication fences. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchThreadStateControllerOwner, { type WorkbenchThreadStateControllerOptions } from "./WorkbenchThreadStateController";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";
import type { WorkbenchProjectStateUpdate } from "../lib/workbench/project/project-state";
import type { WorkbenchReloadDirtSnapshot } from "../lib/types";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadSidebarSnapshot, WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";

type TestControllerOptions = Omit<WorkbenchThreadStateControllerOptions, "resolveGitArc" | "resolveGitArcPlan" | "runGitArcTransition">
  & Partial<Pick<WorkbenchThreadStateControllerOptions, "resolveGitArc" | "resolveGitArcPlan" | "runGitArcTransition">>;

class WorkbenchThreadStateController extends WorkbenchThreadStateControllerOwner {
  constructor(options: TestControllerOptions) {
    super({
      resolveGitArc: async () => null,
      resolveGitArcPlan: async () => null,
      runGitArcTransition: async (_projectId, operation) => await operation(),
      ...options,
    });
  }
}

function projectUpdate(projectId: string, revision = 1): WorkbenchProjectStateUpdate {
  return {
    projectId,
    revision,
    snapshot: {
      changes: {},
      projectId,
      root: projectId,
      rootPath: `C:/projects/${projectId}`,
      roots: [{ id: projectId, isPrimary: true, name: projectId, relativePath: projectId, rootPath: `C:/projects/${projectId}` }],
      tree: [],
      workbenchStorageRootPath: "C:/projects/workbench",
    },
    updateKind: "project",
  };
}

function projectState(overrides: {
  getCurrentUpdate?: (projectId: string) => WorkbenchProjectStateUpdate | null;
  observe?: (projectId: string, publish: (update: WorkbenchProjectStateUpdate) => void) => () => void;
} = {}) {
  return {
    getCurrentUpdate: overrides.getCurrentUpdate ?? (() => null),
    handleRequest: async () => ({ accepted: true }),
    observe: overrides.observe ?? (() => () => undefined),
  };
}

function projectCatalog() {
  return { data: [], rootPath: "C:/projects" };
}

function projectOption(id: string, rootPath: string) {
  return {
    id,
    kind: "git" as const,
    lastCommitTimeMs: null,
    name: id,
    relativePath: id,
    rootPath,
    roots: [{ id, isPrimary: true, name: id, relativePath: id, rootPath }],
  };
}

function threadStatePath(root: string, projectId: string) {
  return path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment(projectId)}.json`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 1_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("UI subscribers share headless observation and warm snapshots without owning reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-state-"));
  const published: Array<{ connectionId: string; revision: number }> = [];
  let reconciliations = 0;
  let projectObservationStarts = 0;
  let projectObservationStops = 0;
  const knownEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "known" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Known",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState({ observe: () => { projectObservationStarts += 1; return () => { projectObservationStops += 1; }; } }),
    publish: (connectionId, snapshot) => {
      if (!("updateKind" in snapshot)) published.push({ connectionId, revision: snapshot.revision });
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliations += 1;
      acceptProviderSnapshot("codex", [knownEntry], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  const first = await controller.open("a", "project");
  assert.equal(first.sidebar.freshness, "loading");
  await waitFor(() => reconciliations === 1, "Initial reconciliation did not start.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = await controller.open("b", "project");
  assert.equal(second.sidebar.freshness, "fresh", second.sidebar.error ?? "Reconciliation did not become fresh.");
  assert.equal(second.sidebar.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "known"), true);
  assert.deepEqual(second.catalog, projectCatalog());
  assert.equal(reconciliations, 1);
  assert.equal(projectObservationStarts, 1);
  await controller.refresh("project");
  assert.equal(reconciliations, 2);
  assert.deepEqual(new Set(published.map((entry) => entry.connectionId)), new Set(["a", "b"]));
  for (const connectionId of ["a", "b"]) {
    const revisions = published.filter((entry) => entry.connectionId === connectionId).map((entry) => entry.revision);
    assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right));
    assert.equal(new Set(revisions).size, revisions.length);
  }
  await controller.close("a");
  assert.equal(projectObservationStops, 0);
  await controller.close("b");
  assert.equal(projectObservationStops, 0);
  await controller.dispose();
  assert.equal(projectObservationStops, 1);
});

test("incomplete provider snapshots retain unseen rows until an authoritative snapshot arrives", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-progressive-"));
  const oldEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "old" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Old",
  };
  const newEntry = { ...oldEntry, activityAt: 2, identity: { harness: "codex" as const, threadId: "new" }, title: "New" };
  let reconciliation = 0;
  let incompleteInstalled = false;
  let releaseFinal = () => undefined;
  const finalGate = new Promise<void>((resolve) => { releaseFinal = resolve; });
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliation += 1;
      if (reconciliation === 1) {
        acceptProviderSnapshot("codex", [oldEntry], { complete: true });
        return [];
      }
      acceptProviderSnapshot("codex", [newEntry], { complete: false });
      incompleteInstalled = true;
      await finalGate;
      acceptProviderSnapshot("codex", [newEntry], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await waitFor(() => reconciliation === 1, "Initial provider snapshot was not installed.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const refreshing = controller.refresh("project");
  await waitFor(() => incompleteInstalled, "Incomplete provider snapshot was not installed.");
  const incomplete = await controller.getSnapshot("project");
  assert.deepEqual(incomplete.entries.filter((entry) => entry.entryKind !== "draft").map((entry) => entry.identity.threadId).sort(), ["new", "old"]);
  releaseFinal();
  await refreshing;
  const complete = await controller.getSnapshot("project");
  assert.deepEqual(complete.entries.filter((entry) => entry.entryKind !== "draft").map((entry) => entry.identity.threadId), ["new"]);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("concurrent first opens share one project initialization and observation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-concurrent-open-"));
  let releaseRoot = (_root: string) => undefined;
  const rootGate = new Promise<string>((resolve) => { releaseRoot = resolve; });
  let projectLoads = 0;
  let reconciliations = 0;
  let observationStarts = 0;
  let observationStops = 0;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState({
      observe: () => { observationStarts += 1; return () => { observationStops += 1; }; },
    }),
    publish: () => undefined,
    reconcileProject: async () => { reconciliations += 1; return []; },
    resolveProjectRoot: async () => { projectLoads += 1; return await rootGate; },
    storageRoot: root,
  });
  const firstOpen = controller.open("first", "project");
  const secondOpen = controller.open("second", "project");
  await waitFor(() => projectLoads === 1, "Shared project initialization did not resolve the project root.");
  assert.equal(projectLoads, 1);
  releaseRoot(root);
  await Promise.all([firstOpen, secondOpen]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(projectLoads, 1);
  assert.equal(observationStarts, 1);
  assert.equal(reconciliations, 1);
  await controller.close("first");
  assert.equal(observationStops, 0);
  await controller.close("second");
  assert.equal(observationStops, 0);
  await controller.dispose();
  assert.equal(observationStops, 1);
});

test("project-local and old central thread state stay read-only until a real mutation writes current central state", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-central-"));
  const legacyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-legacy-"));
  const centralWinsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-central-wins-"));
  const fileName = (projectId: string) => `${encodeTranscriptPathSegment(projectId)}.json`;
  const statePath = (root: string, projectId: string) => path.join(root, ".workbench", "runtime", "thread-state", fileName(projectId));
  const draft = (projectId: string, draftId: string, prompt: string) => ({
    agent: null, attachments: [], clientUpdatedAt: 1, composerSettings: {}, createdAt: 1,
    draftId, harness: "codex" as const, model: null, profileId: null, projectId, prompt,
    reasoningEffort: null, serviceTier: null, updatedAt: 1,
  });
  const migratedDraft = draft("migrated", "00000000-0000-4000-8000-000000000011", "Migrated draft");
  const staleDraft = draft("central-wins", "00000000-0000-4000-8000-000000000012", "Stale legacy draft");
  const centralDraft = draft("central-wins", "00000000-0000-4000-8000-000000000013", "Central draft");
  const centralV1Draft = draft("central-v1", "00000000-0000-4000-8000-000000000014", "Central v1 draft");
  await fs.mkdir(path.dirname(statePath(legacyRoot, "migrated")), { recursive: true });
  await fs.writeFile(statePath(legacyRoot, "migrated"), JSON.stringify({ drafts: [migratedDraft], threads: [], version: 1 }), "utf8");
  await fs.mkdir(path.dirname(statePath(centralWinsRoot, "central-wins")), { recursive: true });
  await fs.writeFile(statePath(centralWinsRoot, "central-wins"), JSON.stringify({ drafts: [staleDraft], threads: [], version: 1 }), "utf8");
  await fs.writeFile(path.join(centralWinsRoot, ".workbench", "keep.txt"), "keep", "utf8");
  await fs.mkdir(path.dirname(statePath(storageRoot, "central-wins")), { recursive: true });
  await fs.writeFile(statePath(storageRoot, "central-wins"), JSON.stringify({ drafts: [centralDraft], threads: [], version: 2 }), "utf8");
  await fs.writeFile(statePath(storageRoot, "central-v1"), JSON.stringify({ drafts: [centralV1Draft], threads: [], version: 1 }), "utf8");

  const resolvedProjects: string[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("migrated", legacyRoot), projectOption("central-wins", centralWinsRoot), projectOption("central-v1", legacyRoot)],
      rootPath: storageRoot,
    }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [], { complete: true });
      return [];
    },
    resolveProjectRoot: async (projectId) => {
      resolvedProjects.push(projectId);
      return projectId === "migrated" ? legacyRoot : centralWinsRoot;
    },
    storageRoot,
  });
  const [migratedOpen, centralOpen, centralV1Open] = await Promise.all([
    controller.open("migrated-observer", "migrated"),
    controller.open("central-observer", "central-wins"),
    controller.open("central-v1-observer", "central-v1"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(migratedOpen.sidebar.entries.some((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Migrated draft"), true);
  assert.equal(centralOpen.sidebar.entries.some((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Central draft"), true);
  assert.equal(centralOpen.sidebar.entries.some((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Stale legacy draft"), false);
  assert.equal(centralV1Open.sidebar.entries.some((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Central v1 draft"), true);
  const migratedEntry = migratedOpen.sidebar.entries.find((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Migrated draft");
  const centralEntry = centralOpen.sidebar.entries.find((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Central draft");
  assert.deepEqual(migratedEntry?.entryKind === "draft" ? migratedEntry.metadata : null, { archived: false, pinned: false, snoozed: false });
  assert.deepEqual(centralEntry?.entryKind === "draft" ? centralEntry.metadata : null, { archived: false, pinned: false, snoozed: false });
  assert.deepEqual(resolvedProjects, ["migrated"]);
  await assert.rejects(fs.readFile(statePath(storageRoot, "migrated"), "utf8"), (error) => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.deepEqual(JSON.parse(await fs.readFile(statePath(legacyRoot, "migrated"), "utf8")), { drafts: [migratedDraft], threads: [], version: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(statePath(centralWinsRoot, "central-wins"), "utf8")), { drafts: [staleDraft], threads: [], version: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(statePath(storageRoot, "central-wins"), "utf8")), { drafts: [centralDraft], threads: [], version: 2 });
  assert.deepEqual(JSON.parse(await fs.readFile(statePath(storageRoot, "central-v1"), "utf8")), { drafts: [centralV1Draft], threads: [], version: 1 });
  assert.equal(await fs.readFile(path.join(centralWinsRoot, ".workbench", "keep.txt"), "utf8"), "keep");
  await controller.handleRequest("migrated-observer", {
    draftId: migratedDraft.draftId,
    method: "workbench/thread-state/draft/pin/set",
    pinned: true,
    projectId: "migrated",
  });
  const lazilyWritten = JSON.parse(await fs.readFile(statePath(storageRoot, "migrated"), "utf8")) as { drafts: Array<{ pinned?: boolean }>; version?: number };
  assert.equal(lazilyWritten.version, 3);
  assert.equal(lazilyWritten.drafts[0]?.pinned, true);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath(legacyRoot, "migrated"), "utf8")), { drafts: [migratedDraft], threads: [], version: 1 });
  await controller.dispose();
  await Promise.all([storageRoot, legacyRoot, centralWinsRoot].map((root) => fs.rm(root, { force: true, recursive: true })));
});

test("reload dirt publishes through every observed project's existing sidebar channel", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-dirt-"));
  let dirt: WorkbenchReloadDirtSnapshot = { dirtyScopes: [], error: null, pendingScopes: [] };
  let dirtListener = () => undefined;
  let unsubscribed = false;
  const published: WorkbenchThreadSidebarSnapshot[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    getReloadDirt: () => dirt!,
    projectState: projectState(),
    publish: (_connectionId, update) => { if (!("updateKind" in update)) published.push(update); },
    reconcileProject: async () => [],
    resolveProjectRoot: async () => root,
    storageRoot: root,
    subscribeReloadDirt: (listener) => {
      dirtListener = listener;
      return () => { unsubscribed = true; };
    },
  });
  try {
    const opened = await controller.open("connection", "project");
    assert.deepEqual(opened.sidebar.reloadDirt, dirt);
    dirt = {
      dirtyScopes: [{ description: "Core", destructive: false, scope: "server:core" }],
      error: null,
      pendingScopes: [],
    };
    dirtListener();
    await waitFor(() => published.some((sidebar) => sidebar.reloadDirt?.dirtyScopes[0]?.scope === "server:core"), "Reload dirt did not publish.");
  } finally {
    await controller.dispose();
    assert.equal(unsubscribed, true);
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("stored state repairs invalid leaves without erasing thread or draft siblings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-conformance-"));
  const stateFile = threadStatePath(root, "project");
  const record = {
    activityAt: 10,
    entryKind: "thread",
    gitArc: {
      checkpointCommit: "invalid",
      claimedPaths: ["webapp"],
      intentDescription: "",
      intentName: "work",
      phase: "active",
      proposals: [],
      updatedAt: "now",
    },
    identity: { harness: "codex", threadId: "kept-thread" },
    lifecycle: { agent: { agentStatus: "working" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    providerObserved: true,
    title: "Kept title",
  };
  const draft = {
    agent: null,
    attachments: [{ kind: "kept" }, undefined, { kind: "also-kept" }],
    clientUpdatedAt: 2,
    composerSettings: {},
    createdAt: 1,
    draftId: "00000000-0000-4000-8000-000000000099",
    harness: "codex",
    model: null,
    pinned: true,
    profileId: null,
    projectId: "old-project",
    prompt: "Kept draft",
    reasoningEffort: null,
    serviceTier: null,
    snoozed: false,
    updatedAt: 2,
  };
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify({ drafts: [draft], records: [record], version: 3 }), "utf8");

  let reconciliations = 0;
  const logs: string[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    log: (message) => logs.push(message),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliations += 1;
      acceptProviderSnapshot("codex", [{
        activityAt: 11,
        entryKind: "thread",
        identity: { harness: "codex", threadId: "kept-thread" },
        lifecycle: { agent: { agentStatus: "working" }, kind: "working", reason: "acceptedIntent", settled: false },
        metadata: { archived: false, pinned: false, snoozed: false },
        title: "Provider title",
      }], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });

  const opened = await controller.open("observer", "project");
  const openedThread = opened.sidebar.entries.find((entry) => entry.entryKind === "thread");
  const openedDraft = opened.sidebar.entries.find((entry) => entry.entryKind === "draft");
  assert.deepEqual(openedThread?.entryKind === "thread" ? {
    gitArc: openedThread.gitArc,
    lifecycle: openedThread.lifecycle,
    metadata: openedThread.metadata,
    title: openedThread.title,
  } : null, {
    gitArc: undefined,
    lifecycle: record.lifecycle,
    metadata: record.metadata,
    title: "Kept title",
  });
  assert.deepEqual(openedDraft?.entryKind === "draft" ? {
    attachments: openedDraft.draft.attachments,
    metadata: openedDraft.metadata,
    projectId: openedDraft.draft.projectId,
    prompt: openedDraft.draft.prompt,
  } : null, {
    attachments: [{ kind: "kept" }, null, { kind: "also-kept" }],
    metadata: { archived: false, pinned: true, snoozed: false },
    projectId: "project",
    prompt: "Kept draft",
  });
  await waitFor(() => reconciliations === 1, "Reconciliation did not start after conformant state installation.");
  const reconciled = await controller.getSnapshot("project");
  const reconciledThread = reconciled.entries.find((entry) => entry.entryKind === "thread");
  assert.equal(reconciledThread?.entryKind === "thread" ? reconciledThread.lifecycle.kind : null, "working");
  assert.equal(logs.some((message) => message.includes("repairedPaths=gitArc")), true);
  assert.equal(logs.some((message) => message.includes("projectId")), true);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("an unidentified stored record cannot reconcile or overwrite its source file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-unidentified-"));
  const stateFile = threadStatePath(root, "project");
  const source = JSON.stringify({
    drafts: [],
    records: [{
      activityAt: 1,
      entryKind: "thread",
      identity: { harness: "codex" },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
      title: "Unidentified",
    }],
    version: 3,
  });
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, source, "utf8");
  let reconciliations = 0;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => { reconciliations += 1; return []; },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });

  await assert.rejects(controller.open("observer", "project"), /without a recoverable identity/u);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reconciliations, 0);
  assert.equal(await fs.readFile(stateFile, "utf8"), source);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("headless provider refresh preserves Git lifecycle and MCP generation without leaking internal fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-headless-mcp-"));
  const gitArc = {
    checkpointCommit: "a".repeat(40), claimedPaths: ["owned.ts"], intentDescription: "", intentName: "Retain Git state",
    phase: "active" as const, proposals: [{ proposalId: "proposal-one", status: "proposed" as const }], updatedAt: new Date(0).toISOString(),
  };
  const gitArcPlan = {
    checkpointCommit: "b".repeat(40), intentDescription: "", intentName: "Retain plan state",
    scopePaths: ["planned.ts"], updatedAt: new Date(1).toISOString(),
  };
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    resolveGitArc: async () => gitArc,
    resolveGitArcPlan: async () => gitArcPlan,
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  const providerEntry: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "headless" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Headless thread",
  };

  const controller = createController();
  await controller.ensureProviderEntry("project", providerEntry);
  await controller.setMcpGeneration("project", "codex", "headless", "epoch:2");
  await controller.refreshGitArcState("project", "codex", "headless");
  await controller.ensureProviderEntry("project", providerEntry);
  assert.equal(await controller.getMcpGeneration("project", "codex", "headless"), "epoch:2");
  const projected = await controller.getSnapshot("project");
  const projectedEntry = projected.entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "headless");
  assert.deepEqual(projectedEntry?.entryKind === "thread" ? { gitArc: projectedEntry.gitArc, gitArcPlan: projectedEntry.gitArcPlan } : null, { gitArc, gitArcPlan });
  assert.equal(projected.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "headless"), true);
  assert.equal(JSON.stringify(projected).includes("mcpGeneration"), false);
  assert.equal(JSON.stringify(projected).includes("providerObserved"), false);
  await controller.dispose();

  const reopened = createController();
  assert.equal(await reopened.getMcpGeneration("project", "codex", "headless"), "epoch:2");
  const reopenedEntry = (await reopened.getSnapshot("project")).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "headless");
  assert.deepEqual(reopenedEntry?.entryKind === "thread" ? { gitArc: reopenedEntry.gitArc, gitArcPlan: reopenedEntry.gitArcPlan } : null, { gitArc, gitArcPlan });
  await reopened.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("legacy settled thread metadata receives a fresh persisted retention grace window", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-v2-mcp-"));
  const statePath = path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment("project")}.json`);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify({
    drafts: [],
    threads: [{
      archived: false,
      harness: "codex",
      lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
      mcpGeneration: "legacy:4",
      pinned: false,
      snoozed: false,
      threadId: "legacy-thread",
      titleFallback: "Legacy thread",
    }],
    version: 2,
  }), "utf8");
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => 1_234,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });

  assert.equal(await controller.getMcpGeneration("project", "codex", "legacy-thread"), "legacy:4");
  assert.equal((await controller.getSnapshot("project")).entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "legacy-thread"), false);
  const migrated = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ gitHistoryCleanedAt?: number | null; mcpGeneration?: string | null; settledAt?: number | null }>; version?: number };
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.records.map(({ gitHistoryCleanedAt, mcpGeneration, settledAt }) => ({ gitHistoryCleanedAt, mcpGeneration, settledAt })), [{ gitHistoryCleanedAt: null, mcpGeneration: "legacy:4", settledAt: 1_234 }]);
  await controller.ensureProviderEntry("project", {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "legacy-thread" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Legacy thread",
  });
  const stored = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ gitHistoryCleanedAt?: number | null; mcpGeneration?: string | null; providerObserved?: boolean; settledAt?: number | null }>; version?: number };
  assert.equal(stored.version, 3);
  assert.deepEqual(stored.records.map(({ gitHistoryCleanedAt, mcpGeneration, providerObserved, settledAt }) => ({ gitHistoryCleanedAt, mcpGeneration, providerObserved, settledAt })), [{ gitHistoryCleanedAt: null, mcpGeneration: "legacy:4", providerObserved: true, settledAt: 1_234 }]);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("continuous settlement prunes once per durable epoch, retries failures, and resets on restore", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-git-retention-"));
  const statePath = threadStatePath(root, "project");
  let now = 1_000;
  const pruned: Array<Array<{ harness: "codex" | "copilot" | "opencode"; threadId: string }>> = [];
  let rejectNextPrune = false;
  const providerEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "retained" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Retained thread",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => now,
    projectState: projectState(),
    pruneExpiredGitState: async (_projectId, identities) => {
      if (rejectNextPrune) {
        rejectNextPrune = false;
        throw new Error("Retention cleanup failed.");
      }
      pruned.push(identities);
    },
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [providerEntry], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await waitFor(async () => (await controller.getSnapshot("project")).freshness === "fresh", "Initial reconciliation did not finish.");
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  let stored = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ gitHistoryCleanedAt?: number | null; settledAt?: number | null }> };
  assert.equal(stored.records[0]?.settledAt, 1_000);
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, null);

  now += 13 * 24 * 60 * 60 * 1_000;
  await controller.refresh("project");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pruned.length, 0);
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/restore", projectId: "project",
  });
  stored = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ settledAt?: number | null }> };
  assert.equal(stored.records[0]?.settledAt, null);

  now += 20 * 24 * 60 * 60 * 1_000;
  await controller.refresh("project");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pruned.length, 0);
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  now += 14 * 24 * 60 * 60 * 1_000 + 1;
  await controller.refresh("project");
  await waitFor(() => pruned.length === 1, "Expired settlement did not trigger Git retention cleanup.");
  assert.deepEqual(pruned[0], [providerEntry.identity]);
  await waitFor(async () => {
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ gitHistoryCleanedAt?: number | null }> };
    return persisted.records[0]?.gitHistoryCleanedAt === now;
  }, "Successful retention cleanup was not persisted.");
  stored = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ gitHistoryCleanedAt?: number | null; settledAt?: number | null }> };
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, now);
  await controller.refresh("project");
  await waitFor(async () => (await controller.getSnapshot("project")).freshness === "fresh", "Repeated reconciliation did not finish.");
  assert.equal(pruned.length, 1);

  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/restore", projectId: "project",
  });
  stored = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ gitHistoryCleanedAt?: number | null; settledAt?: number | null }> };
  assert.deepEqual(stored.records.map(({ gitHistoryCleanedAt, settledAt }) => ({ gitHistoryCleanedAt, settledAt })), [{ gitHistoryCleanedAt: null, settledAt: null }]);
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  now += 14 * 24 * 60 * 60 * 1_000 + 1;
  rejectNextPrune = true;
  await controller.refresh("project");
  await waitFor(async () => (await controller.getSnapshot("project")).error?.includes("git-retention: Retention cleanup failed.") === true, "Failed retention cleanup did not surface.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  stored = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ gitHistoryCleanedAt?: number | null }> };
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, null);
  await controller.refresh("project");
  await waitFor(() => pruned.length === 2, "Failed retention cleanup was not retried.");
  await waitFor(async () => {
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ gitHistoryCleanedAt?: number | null }> };
    return persisted.records[0]?.gitHistoryCleanedAt === now;
  }, "Retried retention cleanup was not persisted.");
  stored = JSON.parse(await fs.readFile(statePath, "utf8")) as { records: Array<{ gitHistoryCleanedAt?: number | null }> };
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, now);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("constructing and disposing does not enumerate projects or start migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-no-startup-migration-"));
  let catalogReads = 0;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => { catalogReads += 1; throw new Error("catalog unavailable"); },
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  assert.equal(catalogReads, 0);
  await controller.dispose();
  assert.equal(catalogReads, 0);
  await fs.rm(root, { force: true, recursive: true });
});

test("disposal fences late reconciliation without awaiting its provider request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-dispose-reconcile-"));
  const publications: WorkbenchThreadStateSnapshot[] = [];
  let reconciliationStarted = false;
  let releaseReconciliation = () => undefined;
  const reconciliationGate = new Promise<void>((resolve) => { releaseReconciliation = resolve; });
  const lateEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "late" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Late",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: (_connectionId, snapshot) => { publications.push(snapshot); },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliationStarted = true;
      await reconciliationGate;
      acceptProviderSnapshot("codex", [lateEntry], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await waitFor(() => reconciliationStarted, "Reconciliation did not start.");
  let disposed = false;
  await controller.dispose().then(() => { disposed = true; });
  assert.equal(disposed, true);
  releaseReconciliation();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(publications, []);
  await fs.rm(root, { force: true, recursive: true });
});

test("a late project observer receives the best-known snapshot without starting another observation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-late-observer-"));
  const update = projectUpdate("project", 7);
  const publications: Array<{ connectionId: string; snapshot: WorkbenchThreadStateSnapshot }> = [];
  let currentUpdateReads = 0;
  let observationStarts = 0;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState({
      getCurrentUpdate: () => { currentUpdateReads += 1; return update; },
      observe: () => { observationStarts += 1; return () => undefined; },
    }),
    publish: (connectionId, snapshot) => publications.push({ connectionId, snapshot }),
    reconcileProject: async () => [],
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("first", "project");
  const late = await controller.open("late", "project");
  const projectPublications = publications.filter((entry) => "updateKind" in entry.snapshot && entry.snapshot.updateKind === "project");
  assert.deepEqual(projectPublications.map((entry) => ({ connectionId: entry.connectionId, revision: entry.snapshot.revision })), [
    { connectionId: "first", revision: 7 },
    { connectionId: "late", revision: 7 },
  ]);
  assert.equal(late.project?.revision, 7);
  assert.deepEqual(late.catalog, projectCatalog());
  assert.equal(currentUpdateReads, 2);
  assert.equal(observationStarts, 1);
  await controller.dispose();
});

test("an observer joining before the first project snapshot receives the normal shared publication", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-building-observer-"));
  const publications: Array<{ connectionId: string; snapshot: WorkbenchThreadStateSnapshot }> = [];
  let publishProject = (_update: WorkbenchProjectStateUpdate) => undefined;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState({
      observe: (_projectId, publish) => { publishProject = publish; return () => undefined; },
    }),
    publish: (connectionId, snapshot) => publications.push({ connectionId, snapshot }),
    reconcileProject: async () => [],
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("first", "project");
  await controller.open("joining", "project");
  assert.equal(publications.some((entry) => "updateKind" in entry.snapshot), false);
  publishProject(projectUpdate("project", 1));
  const projectRecipients = publications
    .filter((entry) => "updateKind" in entry.snapshot && entry.snapshot.updateKind === "project")
    .map((entry) => entry.connectionId)
    .sort();
  assert.deepEqual(projectRecipients, ["first", "joining"]);
  await controller.dispose();
});

test("background reconciliation survives UI disconnect and a warm reopen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-warm-reopen-"));
  let reconciliationCount = 0;
  let staleAccept: ((harness: "codex", entries: WorkbenchThreadSidebarEntry[], options: { complete: boolean }) => void) | null = null;
  let releaseStale = () => undefined;
  const known = {
    activityAt: 1,
    entryKind: "thread" as const,
    identity: { harness: "codex" as const, threadId: "known" },
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: true },
    metadata: { archived: false as const, pinned: false, snoozed: false },
    title: "Known",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliationCount += 1;
      if (reconciliationCount === 1) {
        acceptProviderSnapshot("codex", [known], { complete: true });
        return [];
      }
      staleAccept = acceptProviderSnapshot as typeof staleAccept;
      return await new Promise((resolve) => { releaseStale = () => resolve([]); });
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("first", "project");
  await waitFor(() => reconciliationCount === 1, "Initial reconciliation did not start.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await controller.getSnapshot("project")).freshness, "fresh");

  await controller.refresh("project");
  assert.equal(reconciliationCount, 2);
  assert.equal((await controller.getSnapshot("project")).freshness, "fresh");
  await controller.close("first");
  const reopened = await controller.open("reopened", "project");
  assert.equal(reopened.sidebar.freshness, "fresh");
  assert.equal(reopened.sidebar.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "known"), true);
  assert.equal(reconciliationCount, 2);

  staleAccept?.("codex", [{ ...known, identity: { harness: "codex", threadId: "stale" }, title: "Stale" }], { complete: true });
  releaseStale();
  await waitFor(async () => (await controller.getSnapshot("project")).entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "stale"), "Headless reconciliation did not publish after the UI reconnected.");
  await controller.dispose();
});

test("request telemetry reports bounded validation evidence without logging request values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-telemetry-"));
  const logs: string[] = [];
  let now = 10;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    log: (message) => logs.push(message),
    now: () => now++,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  const response = await controller.handleRequest("observer", { method: "not-a-real-method", secret: "never-log-me" });
  assert.equal("error" in response, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /request invalid method=not-a-real-method issueCode=invalid_union issuePath=method/u);
  assert.doesNotMatch(logs[0] ?? "", /request (?:started|completed)/u);
  assert.equal(logs.join("\n").includes("never-log-me"), false);
  await controller.dispose();
});

test("invalid accepted intent telemetry identifies strict-contract drift without logging field values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-invalid-intent-"));
  const logs: string[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    log: (message) => logs.push(message),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  const response = await controller.handleRequest("observer", {
    correlationHandle: "secret-correlation-value",
    identity: { harness: "codex", threadId: "secret-thread-id" },
    method: "workbench/thread-state/intent/accept",
    projectId: "secret-project-id",
    title: "secret title contents",
    turnId: "secret-turn-id",
  });
  assert.equal("error" in response, true);
  const diagnostic = logs.find((message) => message.includes("request invalid")) ?? "";
  assert.match(diagnostic, /issueCode=unrecognized_keys issuePath=root/u);
  assert.match(diagnostic, /issueMessage=Unrecognized key/u);
  assert.match(diagnostic, /keys=correlationHandle,identity,method,projectId,title,turnId/u);
  assert.match(diagnostic, /fields=projectId=string\(17\),title=string\(21\),turnId=string\(14\)/u);
  assert.match(diagnostic, /identityKeys=harness,threadId identityFields=harness=string\(5\),threadId=string\(16\)/u);
  for (const secret of ["secret-correlation-value", "secret-thread-id", "secret-project-id", "secret title contents", "secret-turn-id"]) {
    assert.equal(logs.join("\n").includes(secret), false);
  }
  await controller.dispose();
});

test("draft priority survives autosave and controller restart without a storage migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-draft-priority-"));
  const draftId = "00000000-0000-4000-8000-000000000001";
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  const original = createController();
  await original.open("observer", "project");
  const value = {
    agent: null, attachments: [], clientUpdatedAt: 1, composerSettings: {}, createdAt: 1,
    draftId, harness: "codex" as const, model: null, profileId: null, projectId: "project", prompt: "Priority draft",
    reasoningEffort: null, serviceTier: null, updatedAt: 1,
  };
  await original.handleRequest("observer", { draft: value, method: "workbench/thread-state/draft/upsert", projectId: "project" });
  await original.handleRequest("observer", { draftId, method: "workbench/thread-state/draft/pin/set", pinned: true, projectId: "project" });
  await original.handleRequest("observer", { draftId, method: "workbench/thread-state/draft/snooze/set", projectId: "project", snoozed: true });
  await original.handleRequest("observer", { draft: { ...value, clientUpdatedAt: 2, prompt: "Updated priority draft", updatedAt: 2 }, method: "workbench/thread-state/draft/upsert", projectId: "project" });
  let entry = (await original.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "draft" && candidate.draft.draftId === draftId);
  assert.deepEqual(entry?.entryKind === "draft" ? entry.metadata : null, { archived: false, pinned: true, snoozed: true });
  await original.dispose();

  const reopened = createController();
  const opened = await reopened.open("reopened", "project");
  entry = opened.sidebar.entries.find((candidate) => candidate.entryKind === "draft" && candidate.draft.draftId === draftId);
  assert.equal(entry?.entryKind === "draft" ? entry.draft.prompt : null, "Updated priority draft");
  assert.deepEqual(entry?.entryKind === "draft" ? entry.metadata : null, { archived: false, pinned: true, snoozed: true });
  const stored = JSON.parse(await fs.readFile(path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment("project")}.json`), "utf8")) as { drafts: Array<{ pinned?: boolean; snoozed?: boolean }>; version?: number };
  assert.equal(stored.version, 3);
  assert.deepEqual(stored.drafts.map(({ pinned, snoozed }) => ({ pinned, snoozed })), [{ pinned: true, snoozed: true }]);
  await reopened.dispose();
});

test("accepted intent survives provider discovery lag and releases after its lifecycle advances", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-accepted-"));
  const published: WorkbenchThreadSidebarEntry[] = [];
  const publishedSnapshots: WorkbenchThreadStateSnapshot[] = [];
  let now = 42;
  let providerEntries: WorkbenchThreadSidebarEntry[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => now,
    publish: (_connectionId, snapshot) => {
      publishedSnapshots.push(snapshot);
      if (!("entries" in snapshot)) return;
      const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
      if (entry) published.push(entry);
    },
    projectState: projectState(),
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const draftId = "00000000-0000-4000-8000-000000000001";
  await controller.handleRequest("observer", {
    draft: {
      agent: null, attachments: [], clientUpdatedAt: 2, composerSettings: {}, createdAt: 1,
      draftId, harness: "codex", model: null, profileId: null, projectId: "project",
      prompt: "First user message", reasoningEffort: null, serviceTier: null, updatedAt: 2,
    },
    method: "workbench/thread-state/draft/upsert",
    projectId: "project",
  });
  await controller.handleRequest("observer", { draftId, method: "workbench/thread-state/draft/pin/set", pinned: true, projectId: "project" });
  await controller.handleRequest("observer", { draftId, method: "workbench/thread-state/draft/snooze/set", projectId: "project", snoozed: true });
  publishedSnapshots.length = 0;
  const response = await controller.handleRequest("observer", {
    draftId,
    identity: { harness: "codex", threadId: "provider" },
    method: "workbench/thread-state/intent/accept",
    projectId: "project",
    title: "First user message",
    turnId: "turn",
  });
  assert.equal("error" in response, false);
  const entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
  assert.ok(entry && entry.entryKind !== "draft");
  assert.equal(entry?.title, "First user message");
  assert.equal(entry.lifecycle.kind, "working");
  assert.deepEqual(entry.entryKind === "thread" ? entry.metadata : null, { archived: false, pinned: true, snoozed: false });
  assert.equal(entry?.activityAt, 42);
  assert.equal(entry.entryKind === "thread" ? entry.orderAt : null, 42);
  assert.equal(published.at(-1)?.title, "First user message");
  assert.equal(publishedSnapshots.length, 1);
  assert.equal("entries" in publishedSnapshots[0]!, true);
  if ("entries" in publishedSnapshots[0]!) {
    assert.equal(publishedSnapshots[0].entries.some((candidate) => candidate.entryKind === "draft"), false);
    assert.equal(publishedSnapshots[0].entries.some((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "provider"), true);
  }
  publishedSnapshots.length = 0;
  now = 50;
  await controller.observeActivity("codex", "provider");
  let observed = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "provider");
  assert.equal(observed?.activityAt, 50);
  assert.equal(observed?.entryKind === "thread" ? observed.orderAt : null, 42);
  assert.equal("orderAt" in publishedSnapshots.at(-1)!, false);
  now = 60;
  await controller.observeActivity("codex", "provider", 55);
  observed = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "provider");
  assert.equal(observed?.activityAt, 60);
  assert.equal(observed?.entryKind === "thread" ? observed.orderAt : null, 55);
  const turnStartUpdate = publishedSnapshots.at(-1);
  assert.equal(turnStartUpdate && "orderAt" in turnStartUpdate ? turnStartUpdate.orderAt : null, 55);
  now = 70;
  await controller.observeActivity("codex", "provider");
  observed = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "provider");
  assert.equal(observed?.entryKind === "thread" ? observed.orderAt : null, 55);
  const stored = JSON.parse(await fs.readFile(path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment("project")}.json`), "utf8")) as { drafts: unknown[]; records: Array<{ identity: { threadId: string }; orderAt?: number }> };
  assert.deepEqual(stored.drafts, []);
  assert.equal(stored.records.some((candidate) => candidate.identity.threadId === "provider"), true);
  assert.equal(stored.records.find((candidate) => candidate.identity.threadId === "provider")?.orderAt, 55);
  providerEntries = [{
    activityAt: 999,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "provider" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false },
    orderAt: 999,
    title: "New thread",
  }];
  await controller.refresh("project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const laggingEntry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
  assert.equal(laggingEntry?.activityAt, 70);
  assert.equal(laggingEntry?.title, "First user message");
  assert.equal(laggingEntry?.entryKind === "thread" ? laggingEntry.orderAt : null, 55);
  providerEntries = [];
  await controller.observeLifecycle("codex", "provider", { kind: "turnCompleted", status: "completed", turnId: "turn" });
  await controller.refresh("project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await controller.getSnapshot("project")).entries.some((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider"), false);
  await controller.dispose();
});

test("accepted intent replaces only a neutral headless provider title with the first message", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-accepted-title-"));
  const published: WorkbenchThreadSidebarEntry[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: (_connectionId, snapshot) => {
      if (!("entries" in snapshot)) return;
      published.push(...snapshot.entries.filter((entry) => entry.entryKind !== "draft"));
    },
    reconcileProject: async () => [],
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  const providerEntry = (threadId: string, title: string): Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> => ({
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title,
  });

  await controller.open("observer", "project");
  await controller.ensureProviderEntry("project", providerEntry("neutral", "New thread"));
  await controller.acceptIntent("observer", {
    harness: "codex", projectId: "project", threadId: "neutral", title: "First user message", turnId: "neutral-turn",
  });
  await controller.ensureProviderEntry("project", providerEntry("named", "Meaningful provider title"));
  await controller.acceptIntent("observer", {
    harness: "codex", projectId: "project", threadId: "named", title: "Different user message", turnId: "named-turn",
  });

  const snapshot = await controller.getSnapshot("project");
  assert.equal(snapshot.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "neutral")?.title, "First user message");
  assert.equal(snapshot.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "named")?.title, "Meaningful provider title");
  assert.equal(published.filter((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "neutral").at(-1)?.title, "First user message");
  const stored = JSON.parse(await fs.readFile(path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment("project")}.json`), "utf8")) as { records: Array<{ identity: { threadId: string }; title: string }> };
  assert.equal(stored.records.find((entry) => entry.identity.threadId === "neutral")?.title, "First user message");
  assert.equal(stored.records.find((entry) => entry.identity.threadId === "named")?.title, "Meaningful provider title");
  await controller.dispose();
});

test("successful user input wakes snoozed threads without changing questionnaire turn order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-user-input-wake-"));
  let discovered = false;
  let now = 30;
  const accepted: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 10,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "accepted" },
    lifecycle: { agent: { agentStatus: "working", turnId: "old-turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: true, snoozed: true },
    orderAt: 10,
    title: "Accepted",
  };
  const pending: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 20,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "pending" },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: "pending-turn" },
    metadata: { archived: false, pinned: false, snoozed: true },
    orderAt: 20,
    title: "Pending",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => now,
    projectState: projectState(),
    publish: (_connectionId, snapshot) => {
      if ("entries" in snapshot && snapshot.entries.length === 2) discovered = true;
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [accepted, pending], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await waitFor(() => discovered, "Snoozed threads were not discovered.");

  await controller.acceptIntent("observer", {
    harness: "codex",
    projectId: "project",
    threadId: "accepted",
    title: "Accepted",
    turnId: "new-turn",
  });
  let entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "accepted");
  assert.equal(entry?.entryKind === "thread" ? entry.metadata.snoozed : null, false);
  assert.equal(entry?.entryKind === "thread" ? entry.metadata.pinned : null, true);
  assert.equal(entry?.entryKind === "thread" ? entry.orderAt : null, 30);

  now = 40;
  await controller.observeLifecycle("codex", "pending", { kind: "inputResolved", requestKey: "request" });
  entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "pending");
  assert.equal(entry?.entryKind === "thread" ? entry.metadata.snoozed : null, false);
  assert.equal(entry?.entryKind === "thread" ? entry.lifecycle.kind : null, "working");
  assert.equal(entry?.activityAt, 40);
  assert.equal(entry?.entryKind === "thread" ? entry.orderAt : null, 20);

  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("replayed questionnaire lifecycle does not invent fresh thread activity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-questionnaire-replay-"));
  const publications: WorkbenchThreadStateSnapshot[] = [];
  let now = 20;
  const providerEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 10,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "questionnaire" },
    lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Questionnaire",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => now,
    projectState: projectState(),
    publish: (_connectionId, snapshot) => { publications.push(snapshot); },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [providerEntry], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await waitFor(() => publications.some((snapshot) => "entries" in snapshot && snapshot.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "questionnaire")), "Questionnaire thread was not discovered.");
  publications.length = 0;

  await controller.observeLifecycle("codex", "questionnaire", { kind: "pendingInput", questionnaire: null, requestKey: "request", turnId: "turn" });
  let observed = (await controller.getSnapshot("project")).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "questionnaire");
  assert.equal(observed?.activityAt, 20);
  assert.equal(publications.length, 1);

  now = 30;
  await controller.observeLifecycle("codex", "questionnaire", { kind: "pendingInput", questionnaire: null, requestKey: "request", turnId: "turn" });
  observed = (await controller.getSnapshot("project")).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "questionnaire");
  assert.equal(observed?.activityAt, 20);
  assert.equal(publications.length, 1);

  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("inactive providers release stale questionnaire ownership without changing terminal semantics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-inactive-questionnaire-"));
  const working = (threadId: string): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { agent: { agentStatus: "working", turnId: `${threadId}-turn` }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: threadId,
  });
  const child: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> = {
    activityAt: 1,
    createdAt: 1,
    cwd: root,
    directSubagentIndex: 0,
    entryKind: "subagent",
    identity: { harness: "codex", threadId: "child" },
    lifecycle: { agent: { agentStatus: "working", turnId: "child-turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    name: "Child",
    parentThreadId: "parent",
    pinned: false,
    profileId: "default",
    profileName: "Default",
    projectId: "project",
    title: "Child",
    updatedAt: 1,
  };
  let providerEntries: WorkbenchThreadSidebarEntry[] = [working("top"), child];
  let publishedEntries: WorkbenchThreadSidebarEntry[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: (_connectionId, snapshot) => {
      if ("entries" in snapshot) publishedEntries = snapshot.entries;
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await waitFor(() => publishedEntries.length === 2, "Provider threads were not discovered.");
  await controller.observeLifecycle("codex", "top", { kind: "pendingInput", questionnaire: null, requestKey: "top-request", turnId: "top-turn" });
  await controller.observeLifecycle("codex", "child", { kind: "pendingInput", questionnaire: null, requestKey: "child-request", turnId: "child-turn" });

  await controller.refresh("project");
  await waitFor(() => publishedEntries.every((entry) => entry.entryKind === "draft" || entry.lifecycle.reason === "pendingInput"), "Active questionnaires lost provider ownership.");

  providerEntries = [
    { ...working("top"), lifecycle: { kind: "completed", reason: "providerInactive", settled: true } },
    { ...child, lifecycle: { kind: "completed", reason: "providerInactive", settled: false } },
  ];
  await controller.refresh("project");
  await waitFor(() => {
    const top = publishedEntries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "top");
    const settledChild = publishedEntries.find((entry) => entry.entryKind === "subagent" && entry.identity.threadId === "child");
    return top?.entryKind === "thread"
      && top.lifecycle.kind === "needsAttention"
      && top.lifecycle.reason === "noActiveTurn"
      && settledChild?.entryKind === "subagent"
      && settledChild.lifecycle.kind === "completed"
      && !settledChild.lifecycle.settled;
  }, "Inactive providers did not release stale questionnaire ownership.");

  const completed = await controller.handleRequest("observer", {
    identity: { harness: "codex", threadId: "top" }, method: "workbench/thread-state/status/set", projectId: "project", status: "completed",
  });
  assert.equal("result" in completed ? (completed.result as { accepted?: boolean }).accepted : false, true);
  const settled = await controller.handleRequest("observer", {
    identity: { harness: "codex", threadId: "top" }, method: "workbench/thread-state/settle", projectId: "project",
  });
  assert.equal("result" in settled ? (settled.result as { accepted?: boolean }).accepted : false, true);
  const top = publishedEntries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "top");
  assert.equal(top?.entryKind === "thread" ? top.lifecycle.kind : null, "completed");
  assert.equal(top?.entryKind === "thread" ? top.lifecycle.settled : null, true);

  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("proper questionnaires and late-response history survive controller restarts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-questionnaire-"));
  const providerEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "thread" },
    lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Thread",
  };
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [providerEntry], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  const questionnaire = {
    itemId: "item",
    request: {
      id: "request",
      questions: [{ allowOther: false, header: "Route", id: "route", isSecret: false, options: [{ description: "Continue", label: "Approve" }], question: "Continue?" }],
      submitLabel: "Send",
      summary: "Choose",
      title: "Questionnaire",
    },
    requestKey: "request-key",
    turnId: "turn",
  };

  const first = createController();
  await first.open("first", "project");
  await waitFor(async () => (await first.getSnapshot("project")).entries.length > 0, "Provider thread was not discovered.");
  const jsonOwner = first as unknown as { json: { write(filePath: string, value: unknown): Promise<void> } };
  const write = jsonOwner.json.write.bind(jsonOwner.json);
  let writes = 0;
  jsonOwner.json.write = async (filePath, value) => { writes += 1; await write(filePath, value); };
  await first.observeLifecycle("codex", "thread", { kind: "pendingInput", questionnaire, requestKey: questionnaire.requestKey, turnId: questionnaire.turnId });
  assert.equal(writes, 1);
  const pending = (await first.getSnapshot("project")).entries[0];
  assert.equal(pending?.entryKind === "thread"
    ? pending.pendingQuestionnaire?.requestKey
    : null, "request-key");
  await first.dispose();

  const second = createController();
  await second.open("second", "project");
  await waitFor(async () => {
    const entry = (await second.getSnapshot("project")).entries.find(
      (candidate): candidate is Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => candidate.entryKind === "thread",
    );
    return entry?.pendingQuestionnaire?.requestKey === "request-key";
  }, "Persisted questionnaire was not restored after controller restart.");
  const restored = (await second.getSnapshot("project")).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(restored?.entryKind === "thread" ? restored.pendingQuestionnaire?.requestKey : null, "request-key");
  const rejectedDismissal = await second.handleRequest("second", {
    identity: { harness: "codex", threadId: "thread" },
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: "project",
    requestKey: "different-request",
  });
  assert.equal("result" in rejectedDismissal && (rejectedDismissal.result as { accepted?: boolean }).accepted, false);
  const dismissal = await second.handleRequest("second", {
    identity: { harness: "codex", threadId: "thread" },
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: "project",
    requestKey: "request-key",
  });
  assert.equal("result" in dismissal && (dismissal.result as { accepted?: boolean }).accepted, true);
  const dismissed = (await second.getSnapshot("project")).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(dismissed?.entryKind === "thread" ? dismissed.pendingQuestionnaire ?? null : null, null);
  assert.deepEqual(dismissed?.entryKind === "thread" ? dismissed.questionnaireHistory ?? [] : null, []);
  await second.dispose();

  const third = createController();
  await third.open("third", "project");
  await waitFor(async () => (await third.getSnapshot("project")).entries.some((entry) => entry.entryKind === "thread"), "Dismissed questionnaire thread was not restored.");
  const reloadedDismissal = (await third.getSnapshot("project")).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(reloadedDismissal?.entryKind === "thread" ? reloadedDismissal.pendingQuestionnaire ?? null : null, null);
  assert.deepEqual(reloadedDismissal?.entryKind === "thread" ? reloadedDismissal.questionnaireHistory ?? [] : null, []);
  const repeatedDismissal = await third.handleRequest("third", {
    identity: { harness: "codex", threadId: "thread" },
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: "project",
    requestKey: "request-key",
  });
  assert.equal("result" in repeatedDismissal && (repeatedDismissal.result as { accepted?: boolean }).accepted, true);

  await third.observeLifecycle("codex", "thread", { kind: "pendingInput", questionnaire, requestKey: questionnaire.requestKey, turnId: questionnaire.turnId });
  const historyEntry = {
    ...questionnaire,
    insertAfterItemId: "item",
    insertAfterItemIndex: 0,
    resolvedAt: 3,
    response: { answers: { route: { answers: ["Approve"] } } },
    threadId: "thread",
    turnId: "turn",
  };
  const resolved = await third.handleRequest("third", {
    entry: historyEntry,
    identity: { harness: "codex", threadId: "thread" },
    method: "workbench/thread-state/questionnaire/resolve",
    projectId: "project",
  });
  assert.equal("result" in resolved && (resolved.result as { accepted?: boolean }).accepted, true);
  const completed = (await third.getSnapshot("project")).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(completed?.entryKind === "thread" ? completed.pendingQuestionnaire ?? null : null, null);
  assert.equal(completed?.entryKind === "thread" ? completed.questionnaireHistory?.[0]?.requestKey : null, "request-key");
  await third.dispose();

  const fourth = createController();
  await fourth.open("fourth", "project");
  await waitFor(async () => {
    const entry = (await fourth.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "thread");
    return entry?.entryKind === "thread" && entry.questionnaireHistory?.[0]?.requestKey === "request-key";
  }, "Persisted questionnaire history was not restored after controller restart.");
  const reloaded = (await fourth.getSnapshot("project")).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(reloaded?.entryKind === "thread" ? reloaded.pendingQuestionnaire ?? null : null, null);
  assert.equal(reloaded?.entryKind === "thread" ? reloaded.questionnaireHistory?.[0]?.response.answers.route?.answers[0] : null, "Approve");
  await fourth.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("wake waits for every unsnoozed row to become settlement-ready, then wakes only the highest projected snoozed thread", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-one-wake-"));
  const snoozed = (threadId: string, orderAt: number): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: true },
    orderAt,
    title: threadId,
  });
  const providerEntries: WorkbenchThreadSidebarEntry[] = [
    snoozed("a", 3), snoozed("b", 2), snoozed("c", 1),
    {
      activityAt: 4, createdAt: 4, cwd: root, directSubagentIndex: 0, entryKind: "subagent",
      identity: { harness: "codex", threadId: "child" },
      lifecycle: { agent: { agentStatus: "working", turnId: "child-turn" }, kind: "working", reason: "acceptedIntent", settled: false },
      name: "child", parentThreadId: "parent", pinned: false, profileId: "default", profileName: "Default",
      projectId: "project", title: "child", updatedAt: 4,
    },
    {
      activityAt: 5,
      entryKind: "thread",
      identity: { harness: "codex", threadId: "attention" },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
      title: "attention",
    },
  ];
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  const controller = createController();
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reordered = await controller.handleRequest("observer", {
    beforeKey: "codex:a",
    destinationFolderId: null,
    method: "workbench/thread-state/display-order/move",
    projectId: "project",
    section: "snoozed",
    sourceKey: "codex:c",
  });
  assert.equal("result" in reordered && (reordered.result as { accepted?: boolean }).accepted, true);
  const afterReorder = JSON.parse(await fs.readFile(path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment("project")}.json`), "utf8")) as { displayOrder?: unknown };
  assert.ok(afterReorder.displayOrder);
  await controller.observeLifecycle("codex", "child", { kind: "turnCompleted", status: "completed", turnId: "child-turn" });
  const blockedSnoozeState = new Map((await controller.getSnapshot("project")).entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(blockedSnoozeState.get("a"), true);
  assert.equal(blockedSnoozeState.get("b"), true);
  assert.equal(blockedSnoozeState.get("c"), true);
  await controller.observeLifecycle("codex", "attention", { kind: "userCompleted" });
  const snoozeState = new Map((await controller.getSnapshot("project")).entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(snoozeState.get("c"), false);
  assert.equal(snoozeState.get("a"), true);
  assert.equal(snoozeState.get("b"), true);
  const afterWake = JSON.parse(await fs.readFile(path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment("project")}.json`), "utf8")) as { displayOrder?: unknown };
  assert.equal("displayOrder" in afterWake, false);
  await controller.dispose();

  const reopened = createController();
  await reopened.open("reopened", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reopenedSnoozeState = new Map((await reopened.getSnapshot("project")).entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(reopenedSnoozeState.get("c"), false);
  assert.equal(reopenedSnoozeState.get("a"), true);
  assert.equal(reopenedSnoozeState.get("b"), true);
  await reopened.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("thread folders persist across restart and reconcile members that leave their section", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-folders-"));
  const pinned = (threadId: string, orderAt: number): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    orderAt,
    title: threadId,
  });
  const providerEntries: WorkbenchThreadSidebarEntry[] = [pinned("a", 2), pinned("b", 1)];
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  const folderId = "00000000-0000-4000-8000-000000000030";
  const controller = createController();
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const created = await controller.handleRequest("observer", { folderId, method: "workbench/thread-state/display-order/folder/create", projectId: "project", sourceKey: "codex:a", title: "New folder" });
  assert.equal("result" in created && (created.result as { accepted?: boolean }).accepted, true);
  const renamed = await controller.handleRequest("observer", { folderId, method: "workbench/thread-state/display-order/folder/title/set", projectId: "project", title: "Important" });
  assert.equal("result" in renamed && (renamed.result as { accepted?: boolean }).accepted, true);
  const filled = await controller.handleRequest("observer", { beforeKey: null, destinationFolderId: folderId, method: "workbench/thread-state/display-order/move", projectId: "project", section: "pinned", sourceKey: "codex:b" });
  assert.equal("result" in filled && (filled.result as { accepted?: boolean }).accepted, true);
  const draftId = "00000000-0000-4000-8000-000000000031";
  const drafted = await controller.handleRequest("observer", {
    draft: {
      agent: null, attachments: [], clientUpdatedAt: 3, composerSettings: {}, createdAt: 3,
      draftId, harness: "codex", model: null, profileId: null, projectId: "project", prompt: "folder draft",
      reasoningEffort: null, serviceTier: null, updatedAt: 3,
    },
    folderId,
    method: "workbench/thread-state/draft/upsert",
    projectId: "project",
  });
  assert.equal("result" in drafted && (drafted.result as { accepted?: boolean }).accepted, true);
  await controller.dispose();

  const reopened = createController();
  await reopened.open("reopened", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const restoredFolder = (await reopened.getSnapshot("project")).displayOrder?.folders?.[0];
  assert.equal(restoredFolder?.title, "Important");
  assert.deepEqual(restoredFolder?.threadKeys, [`draft:${draftId}`, "codex:a", "codex:b"]);
  const restoredDraft = (await reopened.getSnapshot("project")).entries.find((entry) => entry.entryKind === "draft");
  assert.deepEqual(restoredDraft?.entryKind === "draft" ? restoredDraft.metadata : null, { archived: false, pinned: true, snoozed: false });
  await reopened.acceptIntent("reopened", { draftId, harness: "codex", projectId: "project", threadId: "materialized", title: "Materialized", turnId: "turn" });
  assert.deepEqual((await reopened.getSnapshot("project")).displayOrder?.folders?.[0]?.threadKeys, ["codex:materialized", "codex:a", "codex:b"]);
  await reopened.handleRequest("reopened", { identity: { harness: "codex", threadId: "b" }, method: "workbench/thread-state/pin/set", pinned: false, projectId: "project" });
  assert.deepEqual((await reopened.getSnapshot("project")).displayOrder?.folders?.[0]?.threadKeys, ["codex:materialized", "codex:a"]);
  await reopened.handleRequest("reopened", { identity: { harness: "codex", threadId: "a" }, method: "workbench/thread-state/pin/set", pinned: false, projectId: "project" });
  assert.deepEqual((await reopened.getSnapshot("project")).displayOrder?.folders?.[0]?.threadKeys, ["codex:materialized"]);
  await reopened.handleRequest("reopened", { identity: { harness: "codex", threadId: "materialized" }, method: "workbench/thread-state/pin/set", pinned: false, projectId: "project" });
  assert.deepEqual((await reopened.getSnapshot("project")).displayOrder, {});
  await reopened.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("provider completion auto-completes subagents while top-level turns still need an explicit status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-lifecycle-"));
  const working = (threadId: string): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId },
    lifecycle: { agent: { agentStatus: "working", turnId: `${threadId}-turn` }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false }, title: threadId,
  });
  const child: WorkbenchThreadSidebarEntry = {
    activityAt: 1, createdAt: 1, cwd: root, directSubagentIndex: 0, entryKind: "subagent", identity: { harness: "codex", threadId: "child" },
    lifecycle: { agent: { agentStatus: "working", turnId: "child-turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    name: "Child", parentThreadId: "parent", pinned: false, profileId: "default", profileName: "Default", projectId: "project", title: "Child", updatedAt: 1,
  };
  const parent: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = { ...working("parent"), lifecycle: { kind: "completed", reason: "providerInactive", settled: true } };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [parent, working("top"), child], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lifecycleOf = (snapshot: Awaited<ReturnType<typeof controller.getSnapshot>>, threadId: string) => {
    const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === threadId);
    return entry?.entryKind === "draft" ? null : entry?.lifecycle.kind;
  };
  assert.equal(lifecycleOf(await controller.getSnapshot("project"), "parent"), "working");
  await controller.observeLifecycle("codex", "child", { kind: "turnCompleted", status: "completed", turnId: "child-turn" });
  await controller.observeLifecycle("codex", "top", { kind: "turnCompleted", status: "completed", turnId: "top-turn" });
  const snapshot = await controller.getSnapshot("project");
  assert.equal(lifecycleOf(snapshot, "child"), "completed");
  assert.equal(lifecycleOf(snapshot, "top"), "needsAttention");
  assert.equal(lifecycleOf(snapshot, "parent"), "completed");
  await controller.dispose();
});

test("restoring a terminal thread persists across provider reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-restore-"));
  let publications = 0;
  const terminal: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "terminal" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: true, snoozed: false },
    title: "Terminal",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: (_connectionId, snapshot) => { if ("entries" in snapshot) publications += 1; },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [terminal], { complete: true });
      return [];
    },
    resolveProjectRoot: async () => root,
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  publications = 0;
  const jsonOwner = controller as unknown as { json: { write(filePath: string, value: unknown): Promise<void> } };
  const write = jsonOwner.json.write.bind(jsonOwner.json);
  let writes = 0;
  jsonOwner.json.write = async (filePath, value) => { writes += 1; await write(filePath, value); };
  const responses = await Promise.all(Array.from({ length: 10 }, () => controller.handleRequest("observer", {
    identity: terminal.identity,
    method: "workbench/thread-state/restore",
    projectId: "project",
  })));
  assert.equal(writes, 1);
  assert.equal(publications, 1);
  assert.equal(new Set(responses.map((response) => (response as { result?: { revision?: number } }).result?.revision ?? null)).size, 1);
  const restored = (await controller.getSnapshot("project")).entries[0];
  assert.equal(restored?.entryKind === "thread" ? restored.lifecycle.settled : null, false);
  assert.equal(restored?.entryKind === "thread" ? restored.metadata.pinned : null, true);
  await controller.refresh("project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reconciled = (await controller.getSnapshot("project")).entries[0];
  assert.equal(reconciled?.entryKind === "thread" ? reconciled.lifecycle.settled : null, false);
  await controller.dispose();
});

test("manual status persists, restores settled threads, and rejects provider-owned lifecycles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-manual-attention-"));
  const published: WorkbenchThreadStateSnapshot[] = [];
  let insideGitArcTransition = false;
  let gitArcTransitions = 0;
  let terminalHasGitArc = false;
  let terminalGitArcResolved = false;
  let terminalProposalStatus: "proposed" | null = null;
  const terminal: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "terminal" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: true, snoozed: true },
    title: "Terminal",
  };
  const pending: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...terminal,
    identity: { harness: "codex", threadId: "pending" },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: "turn" },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Pending",
  };
  const working: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...terminal,
    identity: { harness: "codex", threadId: "working" },
    lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Working",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: (_connectionId, snapshot) => published.push(snapshot),
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [terminal, pending, working], { complete: true });
      return [];
    },
    resolveGitArc: async (_projectId, _harness, threadId) => {
      assert.equal(insideGitArcTransition, true);
      return terminalHasGitArc && threadId === "terminal" ? {
        checkpointCommit: "a".repeat(40),
        claimedPaths: terminalGitArcResolved ? [] : ["owned.ts"],
        intentDescription: "",
        intentName: "Keep owned work",
        proposalId: terminalProposalStatus ? "proposal-one" : null,
        proposalStatus: terminalProposalStatus,
        updatedAt: new Date(0).toISOString(),
      } : null;
    },
    resolveProjectRoot: async () => root,
    runGitArcTransition: async (_projectId, operation) => {
      gitArcTransitions += 1;
      insideGitArcTransition = true;
      try {
        return await operation();
      } finally {
        insideGitArcTransition = false;
      }
    },
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await controller.refresh("project");
  const settledSameStatus = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/status/set", projectId: "project", status: "completed",
  });
  assert.equal("result" in settledSameStatus ? (settledSameStatus.result as { accepted?: boolean }).accepted : false, true);
  let entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, terminal.lifecycle);
  assert.deepEqual(entry?.entryKind === "thread" ? entry.metadata : null, terminal.metadata);
  const marked = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/status/set", projectId: "project", status: "needsAttention",
  });
  assert.equal("result" in marked ? (marked.result as { accepted?: boolean }).accepted : false, true);
  entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  assert.deepEqual(entry?.entryKind === "thread" ? entry.metadata : null, { ...terminal.metadata, snoozed: false });
  await controller.refresh("project");
  await new Promise<void>((resolve) => setImmediate(resolve));
  entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  const settledAttention = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  assert.equal("result" in settledAttention ? (settledAttention.result as { accepted?: boolean }).accepted : false, true);
  entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "completed", reason: "userCompleted", settled: true });
  assert.deepEqual(entry?.entryKind === "thread" ? entry.metadata : null, { ...terminal.metadata, snoozed: false });
  const lastPublished = published.at(-1);
  const publishedEntry = lastPublished && "entries" in lastPublished
    ? lastPublished.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal")
    : null;
  assert.deepEqual(publishedEntry?.entryKind === "thread" ? publishedEntry.lifecycle : null, { kind: "completed", reason: "userCompleted", settled: true });
  await controller.refresh("project");
  await new Promise<void>((resolve) => setImmediate(resolve));
  entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "completed", reason: "userCompleted", settled: true });
  const rejected = await controller.handleRequest("observer", {
    identity: pending.identity, method: "workbench/thread-state/status/set", projectId: "project", status: "completed",
  });
  assert.equal("result" in rejected ? (rejected.result as { accepted?: boolean }).accepted : true, false);
  const pendingAfter = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "pending");
  assert.deepEqual(pendingAfter?.entryKind === "thread" ? pendingAfter.lifecycle : null, pending.lifecycle);
  const pendingSettleRejected = await controller.handleRequest("observer", {
    identity: pending.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  assert.equal("result" in pendingSettleRejected ? (pendingSettleRejected.result as { accepted?: boolean }).accepted : true, false);
  const pendingAfterSettle = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "pending");
  assert.deepEqual(pendingAfterSettle?.entryKind === "thread" ? pendingAfterSettle.lifecycle : null, pending.lifecycle);
  const workingRejected = await controller.handleRequest("observer", {
    identity: working.identity, method: "workbench/thread-state/status/set", projectId: "project", status: "stopped",
  });
  assert.equal("result" in workingRejected ? (workingRejected.result as { accepted?: boolean }).accepted : true, false);
  const workingAfter = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "working");
  assert.deepEqual(workingAfter?.entryKind === "thread" ? workingAfter.lifecycle : null, working.lifecycle);
  const sameStatus = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/status/set", projectId: "project", status: "needsAttention",
  });
  assert.equal("result" in sameStatus ? (sameStatus.result as { accepted?: boolean }).accepted : false, true);
  entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  terminalHasGitArc = true;
  terminalGitArcResolved = true;
  const resolvedSettle = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  assert.equal("result" in resolvedSettle ? (resolvedSettle.result as { accepted?: boolean }).accepted : false, true);
  await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/status/set", projectId: "project", status: "needsAttention",
  });
  terminalGitArcResolved = false;
  const claimedSettle = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  assert.equal("result" in claimedSettle ? (claimedSettle.result as { accepted?: boolean }).accepted : true, false);
  terminalGitArcResolved = true;
  terminalProposalStatus = "proposed";
  const proposedSettle = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  assert.equal("result" in proposedSettle ? (proposedSettle.result as { accepted?: boolean }).accepted : true, false);
  assert.equal(gitArcTransitions, 5);
  entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});
