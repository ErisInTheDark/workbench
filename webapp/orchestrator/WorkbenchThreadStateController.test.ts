/* No production exports. Tests protect observation replay, request telemetry, reconciliation, persistence mutations, and stale publication fences. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchThreadStateControllerOwner, { type WorkbenchThreadStateControllerOptions } from "./WorkbenchThreadStateController";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";
import type { WorkbenchProjectStateUpdate } from "../lib/workbench/project/project-state";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";

type TestControllerOptions = Omit<WorkbenchThreadStateControllerOptions, "resolveGitArc" | "runGitArcTransition">
  & Partial<Pick<WorkbenchThreadStateControllerOptions, "resolveGitArc" | "runGitArcTransition">>;

class WorkbenchThreadStateController extends WorkbenchThreadStateControllerOwner {
  constructor(options: TestControllerOptions) {
    super({
      resolveGitArc: async () => null,
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

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("observations are reference counted and warm snapshots do not duplicate reconciliation", async () => {
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
  assert.equal(second.sidebar.freshness, "fresh");
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
  assert.equal(projectObservationStops, 1);
  await controller.dispose();
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
  assert.equal(observationStops, 1);
  await controller.dispose();
});

test("project-local thread state copies centrally without deleting or modifying legacy data", async () => {
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
  await fs.mkdir(path.dirname(statePath(legacyRoot, "migrated")), { recursive: true });
  await fs.writeFile(statePath(legacyRoot, "migrated"), JSON.stringify({ drafts: [migratedDraft], threads: [], version: 1 }), "utf8");
  await fs.mkdir(path.dirname(statePath(centralWinsRoot, "central-wins")), { recursive: true });
  await fs.writeFile(statePath(centralWinsRoot, "central-wins"), JSON.stringify({ drafts: [staleDraft], threads: [], version: 1 }), "utf8");
  await fs.writeFile(path.join(centralWinsRoot, ".workbench", "keep.txt"), "keep", "utf8");
  await fs.mkdir(path.dirname(statePath(storageRoot, "central-wins")), { recursive: true });
  await fs.writeFile(statePath(storageRoot, "central-wins"), JSON.stringify({ drafts: [centralDraft], threads: [], version: 2 }), "utf8");

  const resolvedProjects: string[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("migrated", legacyRoot), projectOption("central-wins", centralWinsRoot)],
      rootPath: storageRoot,
    }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    resolveProjectRoot: async (projectId) => {
      resolvedProjects.push(projectId);
      return projectId === "migrated" ? legacyRoot : centralWinsRoot;
    },
    storageRoot,
  });
  const [migratedOpen, centralOpen] = await Promise.all([
    controller.open("migrated-observer", "migrated"),
    controller.open("central-observer", "central-wins"),
  ]);
  assert.equal(migratedOpen.sidebar.entries.some((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Migrated draft"), true);
  assert.equal(centralOpen.sidebar.entries.some((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Central draft"), true);
  assert.equal(centralOpen.sidebar.entries.some((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Stale legacy draft"), false);
  const migratedEntry = migratedOpen.sidebar.entries.find((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Migrated draft");
  const centralEntry = centralOpen.sidebar.entries.find((entry) => entry.entryKind === "draft" && entry.draft.prompt === "Central draft");
  assert.deepEqual(migratedEntry?.entryKind === "draft" ? migratedEntry.metadata : null, { archived: false, pinned: false, snoozed: false });
  assert.deepEqual(centralEntry?.entryKind === "draft" ? centralEntry.metadata : null, { archived: false, pinned: false, snoozed: false });
  assert.deepEqual(resolvedProjects, ["migrated"]);
  const stored = JSON.parse(await fs.readFile(statePath(storageRoot, "migrated"), "utf8")) as { version?: number };
  assert.equal(stored.version, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(statePath(legacyRoot, "migrated"), "utf8")), { drafts: [migratedDraft], threads: [], version: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(statePath(centralWinsRoot, "central-wins"), "utf8")), { drafts: [staleDraft], threads: [], version: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(statePath(storageRoot, "central-wins"), "utf8")), { drafts: [centralDraft], threads: [], version: 2 });
  assert.equal(await fs.readFile(path.join(centralWinsRoot, ".workbench", "keep.txt"), "utf8"), "keep");
  await controller.dispose();
  await Promise.all([storageRoot, legacyRoot, centralWinsRoot].map((root) => fs.rm(root, { force: true, recursive: true })));
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
  assert.deepEqual(projectPublications.map((entry) => ({ connectionId: entry.connectionId, revision: entry.snapshot.revision })), [{ connectionId: "late", revision: 7 }]);
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

test("aborted background reconciliation never downgrades or blocks a warm reopen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-warm-reopen-"));
  let reconciliationCount = 0;
  let staleAccept: ((harness: "codex", entries: WorkbenchThreadSidebarEntry[]) => void) | null = null;
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
      if (reconciliationCount === 1 || reconciliationCount === 3) {
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
  await waitFor(() => reconciliationCount === 3, "Reopened observation did not start a new reconciliation.");

  staleAccept?.("codex", [{ ...known, identity: { harness: "codex", threadId: "stale" }, title: "Stale" }]);
  releaseStale();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await controller.getSnapshot("project")).entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "stale"), false);
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
  assert.match(logs[0] ?? "", /request started connection=observer method=not-a-real-method/u);
  assert.match(logs[1] ?? "", /request invalid method=not-a-real-method issueCode=invalid_union issuePath=method/u);
  assert.match(logs[2] ?? "", /request completed connection=observer method=not-a-real-method outcome=error/u);
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
  assert.equal(stored.version, 2);
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
  const stored = JSON.parse(await fs.readFile(path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment("project")}.json`), "utf8")) as { drafts: unknown[]; threads: Array<{ orderAt?: number; threadId?: string }> };
  assert.deepEqual(stored.drafts, []);
  assert.equal(stored.threads.some((candidate) => candidate.threadId === "provider"), true);
  assert.equal(stored.threads.find((candidate) => candidate.threadId === "provider")?.orderAt, 55);
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
  assert.equal(laggingEntry?.title, "First user message");
  assert.equal(laggingEntry?.entryKind === "thread" ? laggingEntry.orderAt : null, 55);
  providerEntries = [];
  await controller.observeLifecycle("codex", "provider", { kind: "turnCompleted", status: "completed", turnId: "turn" });
  await controller.refresh("project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await controller.getSnapshot("project")).entries.some((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider"), false);
  await controller.dispose();
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
        proposalId: null,
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
  assert.equal(gitArcTransitions, 4);
  entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});
