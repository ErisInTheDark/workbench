/* No production exports. Tests protect authoritative SQLite persistence, headless ownership, folder persistence, MCP generation, observation replay, reconciliation, mutations, and stale publication fences. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchThreadStateControllerOwner, { type WorkbenchThreadStateControllerOptions } from "./WorkbenchThreadStateController";
import type { WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";
import type { WorkbenchComposerProfileTargetSelection, WorkbenchReloadDirtSnapshot } from "workbench-shared/types";
import { getProjectQualifiedThreadDisplayKey, getThreadDisplayFolderKey } from "workbench-shared/workbench/thread/thread-display-layout";
import { getWorkbenchHomeFolderKey } from "workbench-shared/workbench/thread/home-thread-display-order";
import { projectWorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import { WorkbenchPinnedThreadContextResultSchema, WorkbenchThreadStateMutationResultSchema, WorkbenchThreadTitleMutationResultSchema, type WorkbenchThreadSidebarEntry, type WorkbenchThreadSidebarSnapshot, type WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import WorkbenchThreadStateStore, { type WorkbenchThreadStateGlobalDocumentId, type WorkbenchThreadStatePersistence } from "./WorkbenchThreadStateStore";

type TestControllerOptions = Omit<WorkbenchThreadStateControllerOptions, "hasLiveGitArcClaims" | "resolveGitArc" | "resolveGitArcPlan" | "runGitArcReadTransition" | "threadStateStore">
  & Partial<Pick<WorkbenchThreadStateControllerOptions, "hasLiveGitArcClaims" | "resolveGitArc" | "resolveGitArcPlan" | "runGitArcReadTransition" | "threadStateStore">>
  & {
    storageRoot: string;
  };

class MemoryThreadStatePersistence implements WorkbenchThreadStatePersistence {
  readonly globals = new Map<WorkbenchThreadStateGlobalDocumentId, object>();
  readonly projects = new Map<string, object>();

  async readGlobal(id: WorkbenchThreadStateGlobalDocumentId) {
    return structuredClone(this.globals.get(id) ?? null);
  }

  async readProject(projectId: string) {
    return structuredClone(this.projects.get(projectId) ?? null);
  }

  async writeGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object) {
    this.globals.set(id, structuredClone(document));
  }

  async writeProject(projectId: string, document: object) {
    this.projects.set(projectId, structuredClone(document));
  }
}

const testPersistenceByRoot = new Map<string, MemoryThreadStatePersistence>();

function testPersistence(storageRoot: string) {
  const existing = testPersistenceByRoot.get(storageRoot);
  if (existing) return existing;
  const created = new MemoryThreadStatePersistence();
  testPersistenceByRoot.set(storageRoot, created);
  return created;
}

class WorkbenchThreadStateController extends WorkbenchThreadStateControllerOwner {
  constructor(options: TestControllerOptions) {
    const {
      storageRoot,
      threadStateStore = testPersistence(storageRoot),
      ...controllerOptions
    } = options;
    super({
      hasLiveGitArcClaims: async () => false,
      resolveGitArc: async () => null,
      resolveGitArcPlan: async () => null,
      runGitArcReadTransition: async (_projectId, operation) => await operation(),
      ...controllerOptions,
      threadStateStore,
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

async function readProjectState<T extends object>(storageRoot: string, projectId: string) {
  return await testPersistence(storageRoot).readProject(projectId) as T;
}

async function readGlobalState<T extends object>(storageRoot: string, id: WorkbenchThreadStateGlobalDocumentId) {
  return await testPersistence(storageRoot).readGlobal(id) as T;
}

async function seedProjectState(storageRoot: string, projectId: string, document: object) {
  await testPersistence(storageRoot).writeProject(projectId, document);
}

async function seedGlobalState(storageRoot: string, id: WorkbenchThreadStateGlobalDocumentId, document: object) {
  await testPersistence(storageRoot).writeGlobal(id, document);
}

function pinnedRecord(threadId: string, title: string): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> {
  return {
    activityAt: 1,
    entryKind: "thread" as const,
    identity: { harness: "codex" as const, threadId },
    lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false },
    metadata: { archived: false as const, pinned: true, snoozed: false },
    title,
  };
}

const EMPTY_CODEX_SETTINGS = {
  agentPath: null,
  agentSource: null,
  harness: "codex" as const,
  model: "",
  reasoningEffort: null,
  serviceTier: null,
};

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
  assert.equal(projectObservationStops, 1);
  await controller.open("c", "project");
  assert.equal(projectObservationStarts, 2);
  await controller.close("c");
  assert.equal(projectObservationStops, 2);
  await controller.dispose();
  assert.equal(projectObservationStops, 2);
});

test("global pinned folders import project layout, accept mixed-project members, broadcast, and remove snoozed members", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-global-pinned-layout-"));
  const folderId = "00000000-0000-4000-8000-000000000041";
  const projects = ["project-a", "project-b"];
  await seedProjectState(root, "project-a", {
    displayOrder: { folders: [{ folderId, section: "pinned", threadKeys: ["codex:a"], title: "Everywhere" }] },
    drafts: [],
    records: [pinnedRecord("a", "A")],
    version: 3,
  });
  await seedProjectState(root, "project-b", {
    drafts: [],
    records: [{
      ...pinnedRecord("b", "B"),
      metadata: { archived: false, pinned: false, snoozed: true },
    }],
    version: 3,
  });
  const published: Array<{ connectionId: string; snapshot: WorkbenchThreadStateSnapshot }> = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: projects.map((id) => projectOption(id, path.join(root, id))), rootPath: root }),
    projectState: projectState(),
    publish: (connectionId, snapshot) => { published.push({ connectionId, snapshot }); },
    reconcileProject: async () => [],
    storageRoot: root,
  });
  const opened = await controller.open("observer-a", "project-a", 3);
  await controller.open("observer-b", "project-b", 3);
  await waitFor(
    () => published.some(({ snapshot }) => "updateKind" in snapshot && snapshot.updateKind === "projectThreadSummary" && snapshot.summary.projectId === "project-b"),
    "The cold project summary did not hydrate.",
  );
  assert.equal(opened.pinnedThreadLayout.displayOrder.folders?.[0]?.title, "Everywhere");
  const keyA = getProjectQualifiedThreadDisplayKey("project-a", "codex:a");
  const keyB = getProjectQualifiedThreadDisplayKey("project-b", "codex:b");
  const movedAcrossPriority = await controller.handleRequest("observer-a", {
    beforeKey: getThreadDisplayFolderKey(folderId),
    destinationFolderId: null,
    method: "workbench/thread-state/pinned-display-order/move",
    sourceKey: keyB,
  });
  assert.equal("result" in movedAcrossPriority ? WorkbenchThreadStateMutationResultSchema.parse(movedAcrossPriority.result).accepted : false, true);
  const movedProject = await controller.getSnapshot("project-b");
  const movedEntry = movedProject.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "b");
  assert.deepEqual(movedEntry?.entryKind === "thread" ? movedEntry.metadata : null, { archived: false, pinned: true, snoozed: false });
  const movedLayout = await readGlobalState<{ displayOrder: { pinned?: Record<string, { below: string[] }> } }>(root, "pinnedLayout");
  assert.equal(movedLayout.displayOrder.pinned?.[keyB]?.below.includes(getThreadDisplayFolderKey(folderId)), true);
  const moved = await controller.handleRequest("observer-a", {
    destinationFolderId: folderId,
    folderId: null,
    method: "workbench/thread-state/pinned-display-order/folder/drop",
    sourceKey: keyB,
    targetKey: keyA,
  });
  assert.equal("result" in moved ? WorkbenchThreadStateMutationResultSchema.parse(moved.result).accepted : false, true);
  const stored = await readGlobalState<{ displayOrder: { folders?: Array<{ threadKeys: string[] }> } }>(root, "pinnedLayout");
  assert.deepEqual(stored.displayOrder.folders?.[0]?.threadKeys, [keyB, keyA]);
  const layoutObservers = new Set(published.filter(({ snapshot }) => "updateKind" in snapshot && snapshot.updateKind === "pinnedThreadLayout").map(({ connectionId }) => connectionId));
  assert.deepEqual(layoutObservers, new Set(["observer-a", "observer-b"]));
  await controller.handleRequest("observer-a", {
    identity: { harness: "codex", threadId: "b" },
    method: "workbench/thread-state/snooze/set",
    projectId: "project-b",
    snoozed: true,
  });
  const afterSnooze = await readGlobalState<{ displayOrder: { folders?: Array<{ threadKeys: string[] }> } }>(root, "pinnedLayout");
  assert.deepEqual(afterSnooze.displayOrder.folders?.[0]?.threadKeys, [keyA]);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("a failed cross-priority pinned move restores the loaded project state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-pinned-move-rollback-"));
  const persistence = testPersistence(root);
  await persistence.writeProject("project", {
    drafts: [],
    records: [{
      ...pinnedRecord("thread", "Thread"),
      metadata: { archived: false, pinned: false, snoozed: true },
    }],
    version: 3,
  });
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [projectOption("project", root)], rootPath: root }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    storageRoot: root,
  });
  await controller.open("observer", "project", 3);
  const writeProject = persistence.writeProject.bind(persistence);
  persistence.writeProject = async () => {
    persistence.writeProject = writeProject;
    throw new Error("Project persistence unavailable.");
  };

  await assert.rejects(
    controller.handleRequest("observer", {
      beforeKey: null,
      destinationFolderId: null,
      method: "workbench/thread-state/pinned-display-order/move",
      sourceKey: getProjectQualifiedThreadDisplayKey("project", "codex:thread"),
    }),
    /Project persistence unavailable/u,
  );
  const entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "thread");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.metadata : null, { archived: false, pinned: false, snoozed: true });
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("project, pinned, and home thread state persist authoritatively in SQLite across controller restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-sqlite-authority-"));
  await fs.mkdir(path.join(root, ".workbench"), { recursive: true });
  const database = new WorkbenchDatabaseController({ databasePath: path.join(root, ".workbench", "workbench.sqlite3") });
  const store = new WorkbenchThreadStateStore(database, () => 10);
  const providerEntries: WorkbenchThreadSidebarEntry[] = [
    pinnedRecord("alpha", "Private alpha title"),
    pinnedRecord("beta", "Private beta title"),
  ];
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [projectOption("project", root)], rootPath: root }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
    threadStateStore: store,
  });
  let controller = createController();
  try {
    await controller.openGlobal("global", 6);
    await waitFor(async () => (await controller.getSnapshot("project")).entries.length === 2, "Provider entries did not reconcile.");
    const alphaKey = getProjectQualifiedThreadDisplayKey("project", "codex:alpha");
    const betaKey = getProjectQualifiedThreadDisplayKey("project", "codex:beta");
    const pinnedFolderId = "00000000-0000-4000-8000-000000000301";
    const pinnedResult = await controller.handleRequest("global", {
      folderId: pinnedFolderId,
      method: "workbench/thread-state/pinned-display-order/folder/create",
      sourceKey: alphaKey,
      title: "Pinned group",
    });
    assert.equal("result" in pinnedResult && (pinnedResult.result as { accepted?: boolean }).accepted, true);
    const homeResult = await controller.handleRequest("global", {
      beforeKey: alphaKey,
      destinationFolderKey: null,
      method: "workbench/thread-state/home-display-order/move",
      section: "pinned",
      sourceKey: betaKey,
    });
    assert.equal("result" in homeResult && (homeResult.result as { accepted?: boolean }).accepted, true);

    const projectDocument = await store.readProject("project") as { records?: unknown[] } | null;
    const pinnedDocument = await store.readGlobal("pinnedLayout") as { revision?: number } | null;
    const homeDocument = await store.readGlobal("homeDisplayOrder") as { revision?: number } | null;
    assert.equal(projectDocument?.records?.length, 2);
    assert.equal((pinnedDocument?.revision ?? 0) > 0, true);
    assert.equal((homeDocument?.revision ?? 0) > 0, true);

    await controller.dispose();
    controller = createController();
    const reopened = await controller.openGlobal("reopened", 6);
    assert.equal(reopened.projectSidebars.projects[0]?.entries.length, 2);
    assert.equal(reopened.pinnedThreadLayout.revision, pinnedDocument?.revision);
    assert.equal("homeThreadDisplayOrder" in reopened, true);
    if ("homeThreadDisplayOrder" in reopened) {
      assert.equal(reopened.homeThreadDisplayOrder.revision, homeDocument?.revision);
    }
  } finally {
    await controller.dispose();
    await database.close();
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("authoritative SQLite read and write failures surface at the controller boundary", async () => {
  const readRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-sqlite-read-failure-"));
  const readStore = new MemoryThreadStatePersistence();
  readStore.readProject = async () => { throw new Error("sqlite read unavailable"); };
  const readController = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [projectOption("project", readRoot)], rootPath: readRoot }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    storageRoot: readRoot,
    threadStateStore: readStore,
  });
  try {
    await assert.rejects(readController.getSnapshot("project"), /sqlite read unavailable/u);
  } finally {
    await readController.dispose();
    await fs.rm(readRoot, { force: true, recursive: true });
  }

  const writeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-sqlite-write-failure-"));
  const writeStore = new MemoryThreadStatePersistence();
  const writeController = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [projectOption("project", writeRoot)], rootPath: writeRoot }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    storageRoot: writeRoot,
    threadStateStore: writeStore,
  });
  try {
    await writeController.open("observer", "project", 4);
    writeStore.writeProject = async () => { throw new Error("sqlite write unavailable"); };
    const draftId = "00000000-0000-4000-8000-000000000302";
    await assert.rejects(writeController.handleRequest("observer", {
      draft: {
        agent: null, attachments: [], clientUpdatedAt: 1, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 1,
        draftId, harness: "codex", model: null, profileId: null, projectId: "project", prompt: "Rejected draft",
        reasoningEffort: null, serviceTier: null, updatedAt: 1,
      },
      method: "workbench/thread-state/draft/upsert",
      projectId: "project",
    }), /sqlite write unavailable/u);
  } finally {
    await writeController.dispose();
    await fs.rm(writeRoot, { force: true, recursive: true });
  }
});

test("repairable global pinned layout drift cannot block thread-state open", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-global-pinned-layout-repair-"));
  await seedGlobalState(root, "pinnedLayout", {
    displayOrder: {},
    importedProjectIds: ["project"],
    revision: "old",
    secretField: "must-not-be-logged",
    version: 1,
  });
  const logs: string[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [projectOption("project", root)], rootPath: root }),
    log: (message) => { logs.push(message); },
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    storageRoot: root,
  });

  const opened = await controller.open("observer", "project", 3);

  assert.equal(opened.pinnedThreadLayout.revision, 0);
  assert.match(logs.join("\n"), /Conformed stored pinned thread layout/u);
  assert.match(logs.join("\n"), /revision/u);
  assert.doesNotMatch(logs.join("\n"), /must-not-be-logged/u);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("managed wait state is projected live and never persisted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-waiting-"));
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "waiting-thread" },
    lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Waiting thread",
  };
  let reconciled = false;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [entry], { complete: true });
      reconciled = true;
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await waitFor(() => reconciled, "Waiting-state provider thread was not reconciled.");
  controller.setThreadWaitState("codex", "waiting-thread", ["subagent_wait"]);
  const waiting = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "thread");
  assert.equal(waiting?.entryKind === "thread" ? waiting.waitingFor : null, "subagents");
  await controller.observeTitle("codex", "waiting-thread", "Still waiting");
  const stored = await readProjectState<object>(root, "project");
  assert.equal(JSON.stringify(stored).includes("waitingFor"), false);
  controller.setThreadWaitState("codex", "waiting-thread", []);
  const cleared = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind === "thread");
  assert.equal(cleared?.entryKind === "thread" ? cleared.waitingFor : null, undefined);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("version 3 bootstraps every project summary and publishes cross-project changes only to version 3 observers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-project-summaries-"));
  const reconcileCounts = new Map<string, number>();
  const publications: Array<{ connectionId: string; snapshot: WorkbenchThreadStateSnapshot }> = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [
        projectOption("alpha", path.join(root, "alpha")),
        projectOption("beta", path.join(root, "beta")),
      ],
      rootPath: root,
    }),
    projectState: projectState(),
    publish: (connectionId, snapshot) => publications.push({ connectionId, snapshot }),
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      const reconciliation = (reconcileCounts.get(projectId) ?? 0) + 1;
      reconcileCounts.set(projectId, reconciliation);
      const lifecycle = projectId === "beta" && reconciliation > 1
        ? { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const }
        : { agent: { agentStatus: "working" as const, turnId: "turn" }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false as const };
      acceptProviderSnapshot("codex", [{
        activityAt: reconciliation,
        entryKind: "thread",
        identity: { harness: "codex", threadId: `${projectId}-thread` },
        lifecycle,
        metadata: { archived: false, pinned: false, snoozed: false },
        title: projectId,
      }], { complete: true });
      return [];
    },
    storageRoot: root,
  });

  await controller.open("warm-alpha", "alpha", 2);
  await controller.open("warm-beta", "beta", 2);
  await waitFor(() => reconcileCounts.get("alpha") === 1 && reconcileCounts.get("beta") === 1, "Project summaries did not warm.");
  await new Promise<void>((resolve) => setImmediate(resolve));

  const v2 = await controller.open("v2", "alpha", 2);
  assert.equal("projectThreads" in v2, false);
  const v3 = await controller.open("v3", "alpha", 3);
  assert.deepEqual(v3.projectThreads.projects.map(({ counts, lastThreadUpdateAt, projectId, unsettledThreads }) => ({
    lastThreadUpdateAt,
    projectId,
    threadStatuses: unsettledThreads.map(({ status }) => status),
    working: counts.working,
  })), [
    { lastThreadUpdateAt: 1, projectId: "alpha", threadStatuses: ["working"], working: 1 },
    { lastThreadUpdateAt: 1, projectId: "beta", threadStatuses: ["working"], working: 1 },
  ]);

  publications.length = 0;
  await controller.refresh("beta");
  const summaryPublications = publications.filter((publication) => "updateKind" in publication.snapshot
    && publication.snapshot.updateKind === "projectThreadSummary");
  assert.equal(summaryPublications.length > 0, true);
  assert.equal(summaryPublications.every(({ connectionId }) => connectionId === "v3"), true);
  const update = summaryPublications.at(-1)?.snapshot;
  assert.deepEqual(update && "updateKind" in update && update.updateKind === "projectThreadSummary"
    ? {
      lastThreadUpdateAt: update.summary.lastThreadUpdateAt,
      needsAttention: update.summary.counts.needsAttention,
      threadStatuses: update.summary.unsettledThreads.map(({ status }) => status),
    }
    : null, {
    lastThreadUpdateAt: 1,
    needsAttention: 1,
    threadStatuses: ["needsAttention"],
  });
  await controller.dispose();
});

test("version 3 returns loaded summaries before cold projects and fences progressive pushes to the live observation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-progressive-summaries-"));
  let releaseBeta = () => undefined;
  let releaseGamma = () => undefined;
  const betaRead = new Promise<void>((resolve) => { releaseBeta = resolve; });
  const gammaRead = new Promise<void>((resolve) => { releaseGamma = resolve; });
  const persistence = testPersistence(root);
  const readProject = persistence.readProject.bind(persistence);
  persistence.readProject = async (projectId) => {
    if (projectId === "beta") await betaRead;
    if (projectId === "gamma") await gammaRead;
    return await readProject(projectId);
  };
  const publications: Array<{ connectionId: string; snapshot: WorkbenchThreadStateSnapshot }> = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [
        projectOption("alpha", path.join(root, "alpha")),
        projectOption("beta", path.join(root, "beta")),
        projectOption("gamma", path.join(root, "gamma")),
      ],
      rootPath: root,
    }),
    projectState: projectState(),
    publish: (connectionId, snapshot) => publications.push({ connectionId, snapshot }),
    reconcileProject: async () => [],
    storageRoot: root,
  });

  const opened = await controller.open("progressive", "alpha", 3);
  assert.deepEqual(opened.projectThreads.projects.map(({ projectId }) => projectId), ["alpha"]);

  releaseBeta();
  await waitFor(() => publications.some(({ snapshot }) => (
    "updateKind" in snapshot
    && snapshot.updateKind === "projectThreadSummary"
    && snapshot.summary.projectId === "beta"
  )), "The first cold project summary was not pushed progressively.");

  await controller.close("progressive");
  releaseGamma();
  await controller.dispose();
  assert.equal(publications.some(({ snapshot }) => (
    "updateKind" in snapshot
    && snapshot.updateKind === "projectThreadSummary"
    && snapshot.summary.projectId === "gamma"
  )), false);
  await fs.rm(root, { force: true, recursive: true });
});

test("pinned context admits only an unsnoozed root and its direct subagents, then fences foreign mutations to that observation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-pinned-context-"));
  const pinnedRoot: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 3,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "root-thread" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    title: "Pinned root",
  };
  const directSubagent: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> = {
    activityAt: 2,
    createdAt: 1,
    cwd: path.join(root, "owner"),
    directSubagentIndex: 0,
    entryKind: "subagent",
    identity: { harness: "codex", threadId: "child-thread" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    name: "Child",
    parentThreadId: "root-thread",
    pinned: false,
    profileId: "default",
    profileName: "Default",
    projectId: "owner",
    title: "Child",
    updatedAt: 2,
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("viewed", path.join(root, "viewed")), projectOption("owner", path.join(root, "owner"))],
      rootPath: root,
    }),
    projectState: projectState(),
    publish: () => undefined,
    renameThread: async (_projectId, _harness, _threadId, title) => title,
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      if (projectId === "owner") acceptProviderSnapshot("codex", [pinnedRoot, directSubagent], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("owner-loader", "owner");
  await waitFor(async () => (await controller.getSnapshot("owner")).entries.length === 2, "Pinned owner did not load.");
  await controller.open("viewer", "viewed");

  const opened = await controller.handleRequest("viewer", {
    method: "workbench/thread-state/pin/open",
    projectId: "owner",
    target: { harness: "codex", kind: "subagent", parentThreadId: "root-thread", threadId: "child-thread" },
  });
  const openedContext = WorkbenchPinnedThreadContextResultSchema.parse(opened.result);
  assert.deepEqual(openedContext.context
    ? openedContext.context.entries.map((entry) => entry.entryKind === "draft" ? entry.draft.draftId : entry.identity.threadId)
    : null, ["root-thread", "child-thread"]);

  const renamed = await controller.handleRequest("viewer", {
    identity: { harness: "codex", threadId: "root-thread" },
    method: "workbench/thread-state/title/set",
    projectId: "owner",
    title: "Renamed while open",
  });
  assert.equal(WorkbenchThreadTitleMutationResultSchema.parse(renamed.result).title, "Renamed while open");

  await controller.handleRequest("owner-loader", {
    identity: { harness: "codex", threadId: "root-thread" },
    method: "workbench/thread-state/snooze/set",
    projectId: "owner",
    snoozed: true,
  });
  await controller.open("new-viewer", "viewed");
  const snoozed = await controller.handleRequest("new-viewer", {
    method: "workbench/thread-state/pin/open",
    projectId: "owner",
    target: { kind: "provider", threadId: "root-thread" },
  });
  assert.equal(WorkbenchPinnedThreadContextResultSchema.parse(snoozed.result).context, null);

  await controller.close("viewer");
  await controller.open("viewer", "viewed");
  const rejectedAfterReopen = await controller.handleRequest("viewer", {
    identity: { harness: "codex", threadId: "root-thread" },
    method: "workbench/thread-state/title/set",
    projectId: "owner",
    title: "Must not rename",
  });
  assert.equal(rejectedAfterReopen.error?.code, "invalidProjectObservation");
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
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
  let releaseRead = () => undefined;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const persistence = testPersistence(root);
  const readProject = persistence.readProject.bind(persistence);
  let projectLoads = 0;
  persistence.readProject = async (projectId) => {
    projectLoads += 1;
    await readGate;
    return await readProject(projectId);
  };
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
    storageRoot: root,
  });
  const firstOpen = controller.open("first", "project");
  const secondOpen = controller.open("second", "project");
  await waitFor(() => projectLoads === 1, "Shared project initialization did not read persisted state.");
  assert.equal(projectLoads, 1);
  releaseRead();
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
  assert.equal(observationStops, 1);
});

test("missing SQLite project state initializes empty and the first mutation persists", async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-sqlite-empty-"));
  const persistence = testPersistence(storageRoot);
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [projectOption("project", storageRoot)], rootPath: storageRoot }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    storageRoot,
  });

  assert.equal(await persistence.readProject("project"), null);
  const opened = await controller.open("observer", "project");
  assert.deepEqual(opened.sidebar.entries, []);
  assert.deepEqual(await persistence.readProject("project"), {
    drafts: [],
    newThreadProfile: null,
    records: [],
    version: 4,
  });
  const draftId = "00000000-0000-4000-8000-000000000011";
  await controller.handleRequest("observer", {
    draft: {
      agent: null, attachments: [], clientUpdatedAt: 1, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 1,
      draftId, harness: "codex", model: null, profileId: null, projectId: "project", prompt: "Persisted draft",
      reasoningEffort: null, serviceTier: null, updatedAt: 1,
    },
    method: "workbench/thread-state/draft/upsert",
    projectId: "project",
  });
  const stored = await persistence.readProject("project") as { drafts?: Array<{ draftId: string }> };
  assert.deepEqual(stored.drafts?.map((draft) => draft.draftId), [draftId]);
  await controller.dispose();
  await fs.rm(storageRoot, { force: true, recursive: true });
});

test("reload dirt remains only on legacy project and global observations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-dirt-"));
  let dirt: WorkbenchReloadDirtSnapshot = { dirtyScopes: [], error: null, pendingScopes: [] };
  let dirtListener = () => undefined;
  let unsubscribed = false;
  const published: Array<{ connectionId: string; update: WorkbenchThreadStateSnapshot }> = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("project", root)],
      rootPath: root,
    }),
    getReloadDirt: () => dirt!,
    projectState: projectState(),
    publish: (connectionId, update) => { published.push({ connectionId, update }); },
    reconcileProject: async () => [],
    storageRoot: root,
    subscribeReloadDirt: (listener) => {
      dirtListener = listener;
      return () => { unsubscribed = true; };
    },
  });
  try {
    const legacy = await controller.open("legacy-project", "project", 3);
    const current = await controller.open("current-project", "project", 4);
    const legacyGlobal = await controller.openGlobal("legacy-global", 5);
    const currentGlobal = await controller.openGlobal("current-global", 6);
    assert.deepEqual(legacy.sidebar.reloadDirt, dirt);
    assert.equal(current.sidebar.reloadDirt, undefined);
    assert.deepEqual(legacyGlobal.projectSidebars.projects[0]?.reloadDirt, dirt);
    assert.equal(currentGlobal.projectSidebars.projects[0]?.reloadDirt, undefined);
    published.length = 0;
    dirt = {
      dirtyScopes: [{
        dependantScopes: ["server:websocket"],
        description: "Core",
        destructive: false,
        scope: "server:core",
      }],
      error: null,
      pendingScopes: [],
    };
    dirtListener();
    await waitFor(() => published.some(({ connectionId, update }) => (
      connectionId === "legacy-project"
      && !("updateKind" in update)
      && update.reloadDirt?.dirtyScopes[0]?.scope === "server:core"
    )), "Legacy reload dirt did not publish.");
    assert.equal(published.some(({ connectionId }) => connectionId === "current-project" || connectionId === "current-global"), false);
    const legacyUpdate = published.find(({ connectionId, update }) => (
      connectionId === "legacy-project" && !("updateKind" in update)
    ))?.update;
    assert.equal(
      legacyUpdate && !("updateKind" in legacyUpdate)
        ? legacyUpdate.reloadDirt?.dirtyScopes[0]?.dependantScopes
        : null,
      undefined,
    );
  } finally {
    await controller.dispose();
    assert.equal(unsubscribed, true);
    await fs.rm(root, { force: true, recursive: true });
  }
});

test("stored state repairs invalid leaves without erasing thread or draft siblings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-conformance-"));
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
    attachments: [{ kind: "kept" }, null, { kind: "also-kept" }],
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
  await seedProjectState(root, "project", { drafts: [draft], records: [record], version: 3 });

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

test("daemon thread state owns profile migration, draft defaults, materialization, and reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-profiles-"));
  const draftId = "11111111-1111-4111-8111-111111111111";
  await seedProjectState(root, "project", {
    drafts: [{
      agent: "legacy-agent.md",
      attachments: [],
      clientUpdatedAt: 1,
      composerSettings: {},
      createdAt: 1,
      draftId,
      harness: "codex",
      model: "legacy-model",
      profileId: "legacy-profile",
      projectId: "project",
      prompt: "Profile draft",
      reasoningEffort: "high",
      serviceTier: "fast",
      updatedAt: 2,
    }],
    records: [],
    version: 3,
  });
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    storageRoot: root,
  });
  await controller.open("observer", "project");

  const migrated = {
    kind: "profile",
    profileId: "legacy-profile",
    settings: {
      agentPath: "legacy-agent.md",
      agentSource: null,
      harness: "codex",
      model: "legacy-model",
      reasoningEffort: "high",
      serviceTier: "fast",
    },
  } satisfies WorkbenchComposerProfileTargetSelection;
  assert.deepEqual(await controller.readComposerProfileTarget({ kind: "new-thread", projectId: "project" }), migrated);
  assert.deepEqual(await controller.readComposerProfileTarget({ draftId, harness: "codex", kind: "draft", projectId: "project" }), migrated);

  const selected = {
    kind: "profile",
    profileId: "current-profile",
    settings: {
      agentPath: ".agents/agents/project.md",
      agentSource: "project",
      harness: "codex",
      model: "current-model",
      reasoningEffort: "medium",
      serviceTier: null,
    },
  } satisfies WorkbenchComposerProfileTargetSelection;
  assert.equal(
    await controller.setComposerProfileTarget({ draftId, harness: "codex", kind: "draft", projectId: "project" }, selected),
    true,
  );
  assert.deepEqual(await controller.readComposerProfileTarget({ kind: "new-thread", projectId: "project" }), selected);

  await controller.acceptIntent("observer", {
    draftId,
    harness: "codex",
    projectId: "project",
    threadId: "materialized",
    title: "Profile draft",
    turnId: "turn",
  });
  const providerEntry: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> = {
    activityAt: 3,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "materialized" },
    lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Provider title",
  };
  await controller.ensureProviderEntry("project", providerEntry);
  const threadSlot = { harness: "codex" as const, kind: "thread" as const, projectId: "project", threadId: "materialized" };
  assert.deepEqual(await controller.readComposerProfileTarget(threadSlot), selected);

  const stored = await readProjectState<{
    drafts: unknown[];
    newThreadProfile: WorkbenchComposerProfileTargetSelection;
    records: Array<{ identity: { threadId: string }; profile: WorkbenchComposerProfileTargetSelection | null }>;
    version: number;
  }>(root, "project");
  assert.equal(stored.version, 4);
  assert.deepEqual(stored.drafts, []);
  assert.deepEqual(stored.newThreadProfile, selected);
  assert.deepEqual(stored.records.find((record) => record.identity.threadId === "materialized")?.profile, selected);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("global observation returns full project sidebars and moves durable drafts without selecting a project", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-global-"));
  const draftId = "22222222-2222-4222-8222-222222222222";
  await seedProjectState(root, "alpha", {
    drafts: [{
      agent: "profile-agent.md",
      attachments: [],
      clientUpdatedAt: 2,
      composerSettings: { ...EMPTY_CODEX_SETTINGS, agentPath: "profile-agent.md", model: "gpt-profile" },
      createdAt: 1,
      draftId,
      harness: "codex",
      model: "gpt-profile",
      profileId: "profile-one",
      projectId: "alpha",
      prompt: "Move this durable draft",
      reasoningEffort: null,
      serviceTier: null,
      updatedAt: 2,
    }],
    newThreadProfile: null,
    records: [],
    version: 4,
  });
  await seedProjectState(root, "beta", { drafts: [], newThreadProfile: null, records: [], version: 4 });
  const publications: Array<{ connectionId: string; snapshot: WorkbenchThreadStateSnapshot }> = [];
  let projectObservationStarts = 0;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("alpha", path.join(root, "alpha")), projectOption("beta", path.join(root, "beta"))],
      rootPath: root,
    }),
    projectState: projectState({
      observe: () => {
        projectObservationStarts += 1;
        return () => undefined;
      },
    }),
    publish: (connectionId, snapshot) => { publications.push({ connectionId, snapshot }); },
    reconcileProject: async () => [],
    storageRoot: root,
  });

  const opened = await controller.openGlobal("global");
  assert.deepEqual(opened.projectSidebars.projects.map(({ projectId }) => projectId), ["alpha", "beta"]);
  assert.equal(opened.projectSidebars.projects.find(({ projectId }) => projectId === "alpha")?.entries.some((entry) => entry.entryKind === "draft"), true);
  assert.equal(publications.some(({ snapshot }) => "updateKind" in snapshot && snapshot.updateKind === "project"), false);
  assert.equal(projectObservationStarts, 0);

  const response = await controller.handleRequest("global", {
    destinationProjectId: "beta",
    draftId,
    method: "workbench/thread-state/draft/move",
    sourceProjectId: "alpha",
  });
  const moved = WorkbenchThreadStateMutationResultSchema.parse("result" in response ? response.result : null);
  assert.equal(moved.accepted, true);
  assert.equal((await controller.getSnapshot("alpha")).entries.some((entry) => entry.entryKind === "draft"), false);
  const destinationDraft = (await controller.getSnapshot("beta")).entries.find((entry) => entry.entryKind === "draft");
  assert.deepEqual(destinationDraft?.entryKind === "draft" ? {
    agentPath: destinationDraft.draft.composerSettings.agentPath,
    model: destinationDraft.draft.composerSettings.model,
    profileId: destinationDraft.draft.profileId,
    projectId: destinationDraft.draft.projectId,
  } : null, {
    agentPath: "profile-agent.md",
    model: "gpt-profile",
    profileId: "profile-one",
    projectId: "beta",
  });
  assert.equal(publications.some(({ connectionId, snapshot }) => (
    connectionId === "global"
    && "updateKind" in snapshot
    && snapshot.updateKind === "projectThreadSidebar"
    && snapshot.sidebar.projectId === "beta"
  )), true);

  const storedSource = await readProjectState<{ drafts: unknown[] }>(root, "alpha");
  const storedDestination = await readProjectState<{ drafts: Array<{ projectId?: string }> }>(root, "beta");
  assert.deepEqual(storedSource.drafts, []);
  assert.equal(storedDestination.drafts[0]?.projectId, "beta");
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("home order persists folder blocks and rejects foreign-project folder membership", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-home-thread-order-"));
  const persistence = testPersistence(root);
  const writeGlobal = persistence.writeGlobal.bind(persistence);
  let rejectNextHomeWrite = false;
  persistence.writeGlobal = async (id, document) => {
    if (id === "homeDisplayOrder" && rejectNextHomeWrite) {
      rejectNextHomeWrite = false;
      throw new Error("Home display order persistence unavailable.");
    }
    await writeGlobal(id, document);
  };
  const pinned = (threadId: string, orderAt: number): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    orderAt,
    title: threadId,
  });
  const entriesByProject = new Map<string, WorkbenchThreadSidebarEntry[]>([
    ["alpha", [pinned("a", 20), pinned("b", 10)]],
    ["beta", [{
      ...pinned("c", 30),
      metadata: { archived: false, pinned: false, snoozed: true },
    }]],
  ]);
  const publications: WorkbenchThreadStateSnapshot[] = [];
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("alpha", path.join(root, "alpha")), projectOption("beta", path.join(root, "beta"))],
      rootPath: root,
    }),
    projectState: projectState(),
    publish: (_connectionId, snapshot) => { publications.push(snapshot); },
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", entriesByProject.get(projectId) ?? [], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  const controller = createController();
  const opened = await controller.openGlobal("global", 5);
  assert.equal("homeThreadDisplayOrder" in opened, true);
  await waitFor(async () => (await controller.getSnapshot("alpha")).entries.length === 2, "Alpha threads were not discovered.");
  await waitFor(async () => (await controller.getSnapshot("beta")).entries.length === 1, "Beta threads were not discovered.");

  const folderId = "00000000-0000-4000-8000-000000000202";
  const created = await controller.handleRequest("global", {
    folderId,
    method: "workbench/thread-state/display-order/folder/create",
    projectId: "alpha",
    sourceKey: "codex:a",
    title: "Alpha only",
  });
  assert.equal("result" in created && (created.result as { accepted?: boolean }).accepted, true);

  const alphaA = getProjectQualifiedThreadDisplayKey("alpha", "codex:a");
  const alphaB = getProjectQualifiedThreadDisplayKey("alpha", "codex:b");
  const betaC = getProjectQualifiedThreadDisplayKey("beta", "codex:c");
  const alphaFolder = getWorkbenchHomeFolderKey("alpha", folderId);
  const movedAcrossPriority = await controller.handleRequest("global", {
    beforeKey: alphaA,
    destinationFolderKey: null,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: betaC,
  });
  assert.equal("result" in movedAcrossPriority && (movedAcrossPriority.result as { accepted?: boolean }).accepted, true);
  const movedProject = await controller.getSnapshot("beta");
  const movedEntry = movedProject.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "c");
  assert.deepEqual(movedEntry?.entryKind === "thread" ? movedEntry.metadata : null, { archived: false, pinned: true, snoozed: false });
  const movedHomeOrder = await readGlobalState<{ displayOrder: { pinned?: Record<string, { below: string[] }> } }>(root, "homeDisplayOrder");
  assert.equal(movedHomeOrder.displayOrder.pinned?.[betaC]?.below.includes(alphaA), true);
  rejectNextHomeWrite = true;
  await assert.rejects(controller.handleRequest("global", {
    beforeKey: null,
    destinationFolderKey: alphaFolder,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: alphaB,
  }));
  assert.deepEqual((await controller.getSnapshot("alpha")).displayOrder.folders?.[0]?.threadKeys, ["codex:a"]);

  const filled = await controller.handleRequest("global", {
    beforeKey: null,
    destinationFolderKey: alphaFolder,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: alphaB,
  });
  assert.equal("result" in filled && (filled.result as { accepted?: boolean }).accepted, true);
  assert.deepEqual((await controller.getSnapshot("alpha")).displayOrder.folders?.[0]?.threadKeys, ["codex:a", "codex:b"]);

  const foreign = await controller.handleRequest("global", {
    beforeKey: null,
    destinationFolderKey: alphaFolder,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: betaC,
  });
  assert.equal("result" in foreign && (foreign.result as { accepted?: boolean }).accepted, false);
  assert.deepEqual((await controller.getSnapshot("alpha")).displayOrder.folders?.[0]?.threadKeys, ["codex:a", "codex:b"]);

  const movedFolder = await controller.handleRequest("global", {
    beforeKey: betaC,
    destinationFolderKey: null,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: alphaFolder,
  });
  assert.equal("result" in movedFolder && (movedFolder.result as { accepted?: boolean }).accepted, true);
  assert.equal(publications.some((snapshot) => "updateKind" in snapshot && snapshot.updateKind === "homeThreadDisplayOrder"), true);

  const removedFromFolder = await controller.handleRequest("global", {
    beforeKey: betaC,
    destinationFolderKey: null,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: alphaA,
  });
  assert.equal("result" in removedFromFolder && (removedFromFolder.result as { accepted?: boolean }).accepted, true);
  assert.deepEqual((await controller.getSnapshot("alpha")).displayOrder.folders?.[0]?.threadKeys, ["codex:b"]);
  await controller.dispose();

  const reopened = createController();
  const reopenedResult = await reopened.openGlobal("reopened", 5);
  assert.equal("homeThreadDisplayOrder" in reopenedResult, true);
  if ("homeThreadDisplayOrder" in reopenedResult) {
    assert.equal(reopenedResult.homeThreadDisplayOrder.revision > 0, true);
    assert.equal(Boolean(reopenedResult.homeThreadDisplayOrder.displayOrder.pinned?.[alphaA]), true);
  }
  await reopened.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("an unidentified stored record cannot reconcile or overwrite its source file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-unidentified-"));
  const source = {
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
  };
  await seedProjectState(root, "project", source);
  let reconciliations = 0;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => { reconciliations += 1; return []; },
    storageRoot: root,
  });

  await assert.rejects(controller.open("observer", "project"), /without a recoverable identity/u);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reconciliations, 0);
  assert.deepEqual(await readProjectState(root, "project"), source);
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
  await seedProjectState(root, "project", {
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
  });
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => 1_234,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    storageRoot: root,
  });

  assert.equal(await controller.getMcpGeneration("project", "codex", "legacy-thread"), "legacy:4");
  assert.equal((await controller.getSnapshot("project")).entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "legacy-thread"), false);
  const migrated = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; mcpGeneration?: string | null; settledAt?: number | null }>; version?: number }>(root, "project");
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.records.map(({ gitHistoryCleanedAt, mcpGeneration, settledAt }) => ({ gitHistoryCleanedAt, mcpGeneration, settledAt })), [{ gitHistoryCleanedAt: null, mcpGeneration: "legacy:4", settledAt: 1_234 }]);
  await controller.ensureProviderEntry("project", {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "legacy-thread" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Legacy thread",
  });
  const stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; mcpGeneration?: string | null; providerObserved?: boolean; settledAt?: number | null }>; version?: number }>(root, "project");
  assert.equal(stored.version, 4);
  assert.deepEqual(stored.records.map(({ gitHistoryCleanedAt, mcpGeneration, providerObserved, settledAt }) => ({ gitHistoryCleanedAt, mcpGeneration, providerObserved, settledAt })), [{ gitHistoryCleanedAt: null, mcpGeneration: "legacy:4", providerObserved: true, settledAt: 1_234 }]);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("continuous settlement prunes once per durable epoch, retries failures, and resets on restore", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-git-retention-"));
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
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await waitFor(async () => (await controller.getSnapshot("project")).freshness === "fresh", "Initial reconciliation did not finish.");
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  let stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; settledAt?: number | null }> }>(root, "project");
  assert.equal(stored.records[0]?.settledAt, 1_000);
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, null);

  now += 13 * 24 * 60 * 60 * 1_000;
  await controller.refresh("project");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pruned.length, 0);
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/restore", projectId: "project",
  });
  stored = await readProjectState<{ records: Array<{ settledAt?: number | null }> }>(root, "project");
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
    const persisted = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null }> }>(root, "project");
    return persisted.records[0]?.gitHistoryCleanedAt === now;
  }, "Successful retention cleanup was not persisted.");
  stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; settledAt?: number | null }> }>(root, "project");
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, now);
  await controller.refresh("project");
  await waitFor(async () => (await controller.getSnapshot("project")).freshness === "fresh", "Repeated reconciliation did not finish.");
  assert.equal(pruned.length, 1);

  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/restore", projectId: "project",
  });
  stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; settledAt?: number | null }> }>(root, "project");
  assert.deepEqual(stored.records.map(({ gitHistoryCleanedAt, settledAt }) => ({ gitHistoryCleanedAt, settledAt })), [{ gitHistoryCleanedAt: null, settledAt: null }]);
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  now += 14 * 24 * 60 * 60 * 1_000 + 1;
  rejectNextPrune = true;
  await controller.refresh("project");
  await waitFor(async () => (await controller.getSnapshot("project")).error?.includes("git-retention: Retention cleanup failed.") === true, "Failed retention cleanup did not surface.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null }> }>(root, "project");
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, null);
  await controller.refresh("project");
  await waitFor(() => pruned.length === 2, "Failed retention cleanup was not retried.");
  await waitFor(async () => {
    const persisted = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null }> }>(root, "project");
    return persisted.records[0]?.gitHistoryCleanedAt === now;
  }, "Retried retention cleanup was not persisted.");
  stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null }> }>(root, "project");
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
    storageRoot: root,
  });
  await controller.open("first", "project");
  const late = await controller.open("late", "project");
  const projectPublications = publications.flatMap((entry) => "updateKind" in entry.snapshot && entry.snapshot.updateKind === "project"
    ? [{ connectionId: entry.connectionId, revision: entry.snapshot.revision }]
    : []);
  assert.deepEqual(projectPublications, [
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
    storageRoot: root,
  });
  const original = createController();
  await original.open("observer", "project");
  const value = {
    agent: null, attachments: [], clientUpdatedAt: 1, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 1,
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
  const stored = await readProjectState<{ drafts: Array<{ pinned?: boolean; snoozed?: boolean }>; version?: number }>(root, "project");
  assert.equal(stored.version, 4);
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
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const draftId = "00000000-0000-4000-8000-000000000001";
  await controller.handleRequest("observer", {
    draft: {
      agent: null, attachments: [], clientUpdatedAt: 2, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 1,
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
  const stored = await readProjectState<{ drafts: unknown[]; records: Array<{ identity: { threadId: string }; orderAt?: number }> }>(root, "project");
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
  const completedLifecycle = await controller.observeLifecycle("codex", "provider", { kind: "turnCompleted", status: "completed", turnId: "turn" });
  assert.deepEqual(completedLifecycle, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
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
  const stored = await readProjectState<{ records: Array<{ identity: { threadId: string }; title: string }> }>(root, "project");
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
  const persistence = testPersistence(root);
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
  const writeProject = persistence.writeProject.bind(persistence);
  let writes = 0;
  persistence.writeProject = async (projectId, document) => {
    writes += 1;
    await writeProject(projectId, document);
  };
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

  const repeatedKeyQuestionnaire = {
    ...questionnaire,
    itemId: "item-2",
    request: { ...questionnaire.request, id: "request-2", title: "Questionnaire 2" },
  };
  await third.observeLifecycle("codex", "thread", {
    kind: "pendingInput",
    questionnaire: repeatedKeyQuestionnaire,
    requestKey: repeatedKeyQuestionnaire.requestKey,
    turnId: repeatedKeyQuestionnaire.turnId,
  });
  const repeatedKeyResolution = await third.handleRequest("third", {
    entry: {
      ...repeatedKeyQuestionnaire,
      insertAfterItemId: "item-2",
      insertAfterItemIndex: 1,
      resolvedAt: 4,
      response: { answers: { route: { answers: ["Continue"] } } },
      threadId: "thread",
      turnId: "turn",
    },
    identity: { harness: "codex", threadId: "thread" },
    method: "workbench/thread-state/questionnaire/resolve",
    projectId: "project",
  });
  assert.equal("result" in repeatedKeyResolution && (repeatedKeyResolution.result as { accepted?: boolean }).accepted, true);
  const repeatedKeyHistory = (await third.getSnapshot("project")).entries.find((entry) => entry.entryKind === "thread");
  assert.deepEqual(
    repeatedKeyHistory?.entryKind === "thread"
      ? repeatedKeyHistory.questionnaireHistory?.map((entry) => entry.itemId)
      : null,
    ["item", "item-2"],
  );
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
  assert.deepEqual(
    reloaded?.entryKind === "thread"
      ? reloaded.questionnaireHistory?.map((entry) => entry.itemId)
      : null,
    ["item", "item-2"],
  );
  await fourth.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("wake waits for every unsnoozed row to become settlement-ready, then wakes only the highest projected root snoozed thread", async () => {
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
    storageRoot: root,
  });
  const controller = createController();
  await controller.open("observer", "project");
  await waitFor(async () => (await controller.getSnapshot("project")).entries.length === providerEntries.length, "Threads were not discovered.");
  const reordered = await controller.handleRequest("observer", {
    beforeKey: "codex:a",
    destinationFolderId: null,
    method: "workbench/thread-state/display-order/move",
    projectId: "project",
    section: "snoozed",
    sourceKey: "codex:c",
  });
  assert.equal("result" in reordered && (reordered.result as { accepted?: boolean }).accepted, true);
  const folderId = "00000000-0000-4000-8000-000000000042";
  const foldered = await controller.handleRequest("observer", {
    folderId,
    method: "workbench/thread-state/display-order/folder/create",
    projectId: "project",
    sourceKey: "codex:c",
    title: "Keep asleep",
  });
  assert.equal("result" in foldered && (foldered.result as { accepted?: boolean }).accepted, true);
  const afterReorder = await readProjectState<{ displayOrder?: unknown }>(root, "project");
  assert.ok(afterReorder.displayOrder);
  await controller.observeLifecycle("codex", "child", { kind: "turnCompleted", status: "completed", turnId: "child-turn" });
  const blockedSnoozeState = new Map((await controller.getSnapshot("project")).entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(blockedSnoozeState.get("a"), true);
  assert.equal(blockedSnoozeState.get("b"), true);
  assert.equal(blockedSnoozeState.get("c"), true);
  await controller.observeLifecycle("codex", "attention", { kind: "userCompleted" });
  const snoozeState = new Map((await controller.getSnapshot("project")).entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(snoozeState.get("c"), true);
  assert.equal(snoozeState.get("a"), false);
  assert.equal(snoozeState.get("b"), true);
  const afterWake = await readProjectState<{ displayOrder?: { folders?: Array<{ threadKeys: string[] }> } }>(root, "project");
  assert.deepEqual(afterWake.displayOrder?.folders?.[0]?.threadKeys, ["codex:c"]);
  await controller.dispose();

  const reopened = createController();
  await reopened.open("reopened", "project");
  await waitFor(async () => (await reopened.getSnapshot("project")).entries.length === providerEntries.length, "Reopened threads were not discovered.");
  const reopenedSnapshot = await reopened.getSnapshot("project");
  const reopenedSnoozeState = new Map(reopenedSnapshot.entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(reopenedSnoozeState.get("c"), true);
  assert.equal(reopenedSnoozeState.get("a"), false);
  assert.equal(reopenedSnoozeState.get("b"), true);
  assert.deepEqual(reopenedSnapshot.displayOrder.folders?.[0]?.threadKeys, ["codex:c"]);
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
      agent: null, attachments: [], clientUpdatedAt: 3, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 3,
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

test("drag priority and folder drops update one project-owned state atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-drag-priority-"));
  const source: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "source" },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Source",
  };
  const target: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...source,
    activityAt: 1,
    identity: { harness: "codex", threadId: "target" },
    metadata: { archived: false, pinned: false, snoozed: true },
    title: "Target",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [source, target], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await waitFor(async () => (await controller.getSnapshot("project")).freshness === "fresh", "Project did not reconcile.");

  const crossPriorityMove = await controller.handleRequest("observer", {
    beforeKey: "codex:target",
    destinationFolderId: null,
    method: "workbench/thread-state/display-order/move",
    projectId: "project",
    section: "snoozed",
    sourceKey: "codex:source",
  });
  assert.equal("result" in crossPriorityMove && (crossPriorityMove.result as { accepted?: boolean }).accepted, true);
  let snapshot = await controller.getSnapshot("project");
  let moved = snapshot.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "source");
  assert.deepEqual(moved?.entryKind === "thread" ? moved.metadata : null, { archived: false, pinned: false, snoozed: true });
  assert.deepEqual(projectWorkbenchThreadDisplaySection(snapshot.entries, snapshot.displayOrder, "snoozed").flatMap((item) => (
    item.itemKind === "thread"
      ? [item.entry.entryKind === "draft" ? item.entry.draft.draftId : item.entry.identity.threadId]
      : item.entries.map((entry) => entry.entryKind === "draft" ? entry.draft.draftId : entry.identity.threadId)
  )), ["source", "target"]);

  await controller.handleRequest("observer", {
    method: "workbench/thread-state/priority/set",
    priority: "pinned",
    projectId: "project",
    sourceKey: "codex:source",
  });
  moved = (await controller.getSnapshot("project")).entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "source");
  assert.deepEqual(moved?.entryKind === "thread" ? moved.metadata : null, { archived: false, pinned: true, snoozed: false });

  const folderId = "00000000-0000-4000-8000-000000000077";
  const folderDrop = await controller.handleRequest("observer", {
    destinationFolderId: null,
    folderId,
    method: "workbench/thread-state/display-order/folder/drop",
    projectId: "project",
    section: "snoozed",
    sourceKey: "codex:source",
    targetKey: "codex:target",
  });
  assert.equal("result" in folderDrop && (folderDrop.result as { accepted?: boolean }).accepted, true);
  snapshot = await controller.getSnapshot("project");
  moved = snapshot.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "source");
  assert.deepEqual(moved?.entryKind === "thread" ? moved.metadata : null, { archived: false, pinned: true, snoozed: true });
  assert.deepEqual(snapshot.displayOrder.folders?.[0]?.threadKeys, ["codex:source", "codex:target"]);

  await controller.handleRequest("observer", {
    method: "workbench/thread-state/priority/set",
    priority: "main",
    projectId: "project",
    sourceKey: "codex:source",
  });
  moved = (await controller.getSnapshot("project")).entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "source");
  assert.deepEqual(moved?.entryKind === "thread" ? moved.metadata : null, { archived: false, pinned: false, snoozed: false });
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("cross-project dependent snooze waits for completion and the final live claim", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-dependent-snooze-"));
  const source: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "source" },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Source",
  };
  const claimedArc = {
    checkpointCommit: "a".repeat(40),
    claimedPaths: ["owned.ts"],
    intentDescription: "",
    intentName: "target work",
    phase: "active" as const,
    proposals: [],
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  const target: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...source,
    activityAt: 1,
    gitArc: claimedArc,
    identity: { harness: "codex", threadId: "target" },
    title: "Target",
  };
  let targetArc: typeof claimedArc | null = claimedArc;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/projects/alpha"), projectOption("beta", "C:/projects/beta")],
      rootPath: "C:/projects",
    }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot, acceptGitArcSnapshot) => {
      acceptProviderSnapshot("codex", projectId === "alpha" ? [source] : [target], { complete: true });
      await acceptGitArcSnapshot({
        arcs: projectId === "beta" && targetArc ? [{ harness: "codex", state: targetArc, threadId: "target" }] : [],
        plans: [],
      });
      return [];
    },
    resolveGitArc: async (_projectId, _harness, threadId) => threadId === "target" ? targetArc : null,
    storageRoot: root,
  });
  await controller.openGlobal("observer", 6);
  await waitFor(async () => (
    (await controller.getSnapshot("alpha")).freshness === "fresh"
    && (await controller.getSnapshot("beta")).freshness === "fresh"
  ), "Projects did not reconcile.");
  await controller.handleRequest("observer", {
    identity: source.identity,
    method: "workbench/thread-state/snooze/until",
    projectId: "alpha",
    target: { identity: target.identity, projectId: "beta" },
  });
  await controller.observeLifecycle("codex", "target", { kind: "userCompleted" });
  let sourceEntry = (await controller.getSnapshot("alpha")).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(sourceEntry?.entryKind === "thread" ? sourceEntry.metadata.snoozed : null, true);
  const stored = await readProjectState<{ records: Array<{ snoozedUntil?: unknown }> }>(root, "alpha");
  assert.deepEqual(stored.records[0]?.snoozedUntil, { identity: target.identity, projectId: "beta" });

  targetArc = null;
  await controller.refreshGitArcState("beta", "codex", "target");
  sourceEntry = (await controller.getSnapshot("alpha")).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(sourceEntry?.entryKind === "thread" ? sourceEntry.metadata.snoozed : null, false);
  const storedAfterWake = await readProjectState<{ records: Array<{ snoozedUntil?: unknown }> }>(root, "alpha");
  assert.equal(storedAfterWake.records[0]?.snoozedUntil, null);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("dependent snooze also wakes when claims leave before manual completion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-dependent-snooze-claims-first-"));
  const source: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "source" },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Source",
  };
  const claimedArc = {
    checkpointCommit: "a".repeat(40),
    claimedPaths: ["owned.ts"],
    intentDescription: "",
    intentName: "target work",
    phase: "active" as const,
    proposals: [],
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  const target: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...source,
    activityAt: 1,
    gitArc: claimedArc,
    identity: { harness: "codex", threadId: "target" },
    title: "Target",
  };
  let targetArc: typeof claimedArc | null = claimedArc;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/projects/alpha"), projectOption("beta", "C:/projects/beta")],
      rootPath: "C:/projects",
    }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot, acceptGitArcSnapshot) => {
      acceptProviderSnapshot("codex", projectId === "alpha" ? [source] : [target], { complete: true });
      await acceptGitArcSnapshot({
        arcs: projectId === "beta" && targetArc ? [{ harness: "codex", state: targetArc, threadId: "target" }] : [],
        plans: [],
      });
      return [];
    },
    resolveGitArc: async (_projectId, _harness, threadId) => threadId === "target" ? targetArc : null,
    storageRoot: root,
  });
  await controller.openGlobal("observer", 6);
  await waitFor(async () => (
    (await controller.getSnapshot("alpha")).freshness === "fresh"
    && (await controller.getSnapshot("beta")).freshness === "fresh"
  ), "Projects did not reconcile.");
  await controller.handleRequest("observer", {
    identity: source.identity,
    method: "workbench/thread-state/snooze/until",
    projectId: "alpha",
    target: { identity: target.identity, projectId: "beta" },
  });

  targetArc = null;
  await controller.refreshGitArcState("beta", "codex", "target");
  let sourceEntry = (await controller.getSnapshot("alpha")).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(sourceEntry?.entryKind === "thread" ? sourceEntry.metadata.snoozed : null, true);

  await controller.handleRequest("observer", {
    identity: target.identity,
    method: "workbench/thread-state/status/set",
    projectId: "beta",
    status: "completed",
  });
  sourceEntry = (await controller.getSnapshot("alpha")).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(sourceEntry?.entryKind === "thread" ? sourceEntry.metadata.snoozed : null, false);
  const stored = await readProjectState<{ records: Array<{ snoozedUntil?: unknown }> }>(root, "alpha");
  assert.equal(stored.records[0]?.snoozedUntil, null);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("dependent snooze replacement survives a missing target, skips ordinary auto-wake, and clears manually", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-dependent-snooze-clearing-"));
  const thread = (
    threadId: string,
    metadata: { archived: false; pinned: false; snoozed: boolean },
    lifecycle: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["lifecycle"],
    activityAt: number,
  ): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle,
    metadata,
    title: threadId,
  });
  const source = thread("source", { archived: false, pinned: false, snoozed: false }, { kind: "completed", reason: "providerInactive", settled: false }, 4);
  const ordinary = thread("ordinary", { archived: false, pinned: false, snoozed: true }, { kind: "completed", reason: "providerInactive", settled: false }, 3);
  const active = thread("active", { archived: false, pinned: false, snoozed: false }, {
    agent: { agentStatus: "working", turnId: "active-turn" },
    kind: "working",
    reason: "acceptedIntent",
    settled: false,
  }, 5);
  const targetA = thread("target-a", { archived: false, pinned: false, snoozed: false }, { kind: "needsAttention", reason: "noActiveTurn", settled: false }, 2);
  const targetB = thread("target-b", { archived: false, pinned: false, snoozed: false }, { kind: "needsAttention", reason: "noActiveTurn", settled: false }, 1);
  let betaEntries = [targetA, targetB];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/projects/alpha"), projectOption("beta", "C:/projects/beta")],
      rootPath: "C:/projects",
    }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", projectId === "alpha" ? [source, ordinary, active] : betaEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.openGlobal("observer", 6);
  await waitFor(async () => (
    (await controller.getSnapshot("alpha")).freshness === "fresh"
    && (await controller.getSnapshot("beta")).freshness === "fresh"
  ), "Projects did not reconcile.");

  for (const target of [targetA, targetB]) {
    await controller.handleRequest("observer", {
      identity: source.identity,
      method: "workbench/thread-state/snooze/until",
      projectId: "alpha",
      target: { identity: target.identity, projectId: "beta" },
    });
  }
  let stored = await readProjectState<{ records: Array<{ identity: { threadId: string }; snoozedUntil?: unknown }> }>(root, "alpha");
  assert.deepEqual(
    stored.records.find(({ identity }) => identity.threadId === "source")?.snoozedUntil,
    { identity: targetB.identity, projectId: "beta" },
  );

  betaEntries = [];
  await controller.refresh("beta");
  await waitFor(async () => (await controller.getSnapshot("beta")).freshness === "fresh", "Target removal did not reconcile.");
  await controller.observeLifecycle("codex", "active", { kind: "userCompleted" });
  const snoozeState = new Map((await controller.getSnapshot("alpha")).entries.flatMap((entry) => (
    entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []
  )));
  assert.equal(snoozeState.get("source"), true);
  assert.equal(snoozeState.get("ordinary"), false);

  await controller.handleRequest("observer", {
    identity: source.identity,
    method: "workbench/thread-state/snooze/set",
    projectId: "alpha",
    snoozed: false,
  });
  stored = await readProjectState<{ records: Array<{ identity: { threadId: string }; snoozedUntil?: unknown }> }>(root, "alpha");
  assert.equal(stored.records.find(({ identity }) => identity.threadId === "source")?.snoozedUntil, null);
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("restart reevaluates a persisted dependency when its ready target loaded first", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-dependent-snooze-restart-"));
  const source: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: "source" },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: true },
    title: "Source",
  };
  const target: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...source,
    activityAt: 1,
    identity: { harness: "codex", threadId: "target" },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Target",
  };
  const persistence = testPersistence(root);
  await persistence.writeProject("alpha", {
    drafts: [],
    records: [{ ...source, snoozedUntil: { identity: target.identity, projectId: "beta" } }],
    version: 4,
  });
  await persistence.writeProject("beta", { drafts: [], records: [target], version: 4 });
  let releaseSourceRead = () => undefined;
  const sourceReadGate = new Promise<void>((resolve) => { releaseSourceRead = resolve; });
  const gatedPersistence: WorkbenchThreadStatePersistence = {
    readGlobal: async (id) => await persistence.readGlobal(id),
    readProject: async (projectId) => {
      if (projectId === "alpha") await sourceReadGate;
      return await persistence.readProject(projectId);
    },
    writeGlobal: async (id, document) => await persistence.writeGlobal(id, document),
    writeProject: async (projectId, document) => await persistence.writeProject(projectId, document),
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("beta", "C:/projects/beta"), projectOption("alpha", "C:/projects/alpha")],
      rootPath: "C:/projects",
    }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", projectId === "alpha" ? [source] : [target], { complete: true });
      return [];
    },
    storageRoot: root,
    threadStateStore: gatedPersistence,
  });
  const opening = controller.openGlobal("observer", 6);
  await waitFor(async () => (await controller.getSnapshot("beta")).freshness === "fresh", "Target did not reconcile first.");
  releaseSourceRead();
  await opening;
  await waitFor(async () => {
    const entry = (await controller.getSnapshot("alpha")).entries.find((candidate) => candidate.entryKind === "thread");
    return entry?.entryKind === "thread" && !entry.metadata.snoozed;
  }, "Persisted dependency did not wake after its source project loaded.");
  const stored = await persistence.readProject("alpha") as { records: Array<{ snoozedUntil?: unknown }> };
  assert.equal(stored.records[0]?.snoozedUntil, null);
  await controller.dispose();
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
  const persistence = testPersistence(root);
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
    storageRoot: root,
  });
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  publications = 0;
  const writeProject = persistence.writeProject.bind(persistence);
  let writes = 0;
  persistence.writeProject = async (projectId, document) => {
    writes += 1;
    await writeProject(projectId, document);
  };
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
    hasLiveGitArcClaims: async (_projectId, _harness, threadId) => {
      assert.equal(insideGitArcTransition, true);
      return terminalHasGitArc && !terminalGitArcResolved && threadId === "terminal";
    },
    projectState: projectState(),
    publish: (_connectionId, snapshot) => published.push(snapshot),
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [terminal, pending, working], { complete: true });
      return [];
    },
    runGitArcReadTransition: async (_projectId, operation) => {
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
  const proposedSettle = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/settle", projectId: "project",
  });
  assert.equal("result" in proposedSettle ? (proposedSettle.result as { accepted?: boolean }).accepted : false, true);
  assert.equal(gitArcTransitions, 5);
  entry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "completed", reason: "userCompleted", settled: true });
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});
