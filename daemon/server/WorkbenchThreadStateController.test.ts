/*
 * Exports: none. Tests protect headless thread ownership, mutations, durability, and publication fences.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import WorkbenchThreadStateControllerOwner, { type WorkbenchThreadStateControllerOptions } from "./WorkbenchThreadStateController";
import WorkbenchTurnRecoveryController from "./WorkbenchTurnRecoveryController";
import type { WorkbenchComposerProfile, WorkbenchComposerProfileTargetSelection } from "workbench-shared/types";
import { getProjectQualifiedThreadDisplayKey, getThreadDisplayFolderKey, getThreadDisplayThreadKey } from "workbench-shared/workbench/thread/thread-display-layout";
import { projectWorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import { WorkbenchThreadStateMutationResultSchema, WorkbenchThreadTitleMutationResultSchema, type WorkbenchThreadSidebarEntry, type WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import WorkbenchThreadStateStore, { type WorkbenchStoredThreadTitleHistory, type WorkbenchThreadStateGlobalDocumentId, type WorkbenchThreadStatePersistence } from "./WorkbenchThreadStateStore";
import { normalizeProviderSidebarEntry as normalizeSidebarEntry } from "./WorkbenchThreadStateFeature";
import { parseProjectDocument } from "./database/thread-state/workbench-thread-state-document-source";
import { createWorkbenchProjectThreadSummary } from "workbench-shared/workbench/thread/thread-state";
import { projectWorkbenchThreadStateEntry } from "./workbench-thread-state-record";
import { projectWorkbenchThreadDraft } from "./WorkbenchThreadDraftStore";

import { ProjectIdSchema, WorkbenchTurnIdSchema, WorkbenchThreadIdSchema, type ProjectId } from "workbench-shared/workbench/identity";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

function normalizeProviderSidebarEntry(harness: Parameters<typeof normalizeSidebarEntry>[0], value: unknown) {
  return normalizeSidebarEntry(harness, value, {
    knownThread: reference => ({ threadId: WorkbenchThreadIdSchema.parse(reference) }),
    knownTurn: reference => ({ turnId: WorkbenchTurnIdSchema.parse(reference) }),
  });
}

const fixtureProjectIds = {
  "alpha": ProjectIdSchema.parse("alpha"),
  "beta": ProjectIdSchema.parse("beta"),
  "owner": ProjectIdSchema.parse("owner"),
  "project": ProjectIdSchema.parse("project"),
  "project-a": ProjectIdSchema.parse("project-a"),
  "project-b": ProjectIdSchema.parse("project-b"),
  "viewed": ProjectIdSchema.parse("viewed"),
};

const fixtureTurnIds = {
  "active-turn": WorkbenchTurnIdSchema.parse("active-turn"),
  "child-turn": WorkbenchTurnIdSchema.parse("child-turn"),
  "named-turn": WorkbenchTurnIdSchema.parse("named-turn"),
  "neutral-turn": WorkbenchTurnIdSchema.parse("neutral-turn"),
  "new-turn": WorkbenchTurnIdSchema.parse("new-turn"),
  "next-turn": WorkbenchTurnIdSchema.parse("next-turn"),
  "old-turn": WorkbenchTurnIdSchema.parse("old-turn"),
  "pending-turn": WorkbenchTurnIdSchema.parse("pending-turn"),
  "turn": WorkbenchTurnIdSchema.parse("turn"),
};

const fixtureThreadIds = {
  "a": WorkbenchThreadIdSchema.parse("a"),
  "accepted": WorkbenchThreadIdSchema.parse("accepted"),
  "active": WorkbenchThreadIdSchema.parse("active"),
  "attention": WorkbenchThreadIdSchema.parse("attention"),
  "b": WorkbenchThreadIdSchema.parse("b"),
  "c": WorkbenchThreadIdSchema.parse("c"),
  "child": WorkbenchThreadIdSchema.parse("child"),
  "child-thread": WorkbenchThreadIdSchema.parse("child-thread"),
  "existing": WorkbenchThreadIdSchema.parse("existing"),
  "headless": WorkbenchThreadIdSchema.parse("headless"),
  "history-thread": WorkbenchThreadIdSchema.parse("history-thread"),
  "kept-thread": WorkbenchThreadIdSchema.parse("kept-thread"),
  "known": WorkbenchThreadIdSchema.parse("known"),
  "late": WorkbenchThreadIdSchema.parse("late"),
  "materialized": WorkbenchThreadIdSchema.parse("materialized"),
  "named": WorkbenchThreadIdSchema.parse("named"),
  "neutral": WorkbenchThreadIdSchema.parse("neutral"),
  "old": WorkbenchThreadIdSchema.parse("old"),
  "ordinary": WorkbenchThreadIdSchema.parse("ordinary"),
  "parent": WorkbenchThreadIdSchema.parse("parent"),
  "pending": WorkbenchThreadIdSchema.parse("pending"),
  "provider": WorkbenchThreadIdSchema.parse("provider"),
  "questionnaire": WorkbenchThreadIdSchema.parse("questionnaire"),
  "retained": WorkbenchThreadIdSchema.parse("retained"),
  "root-thread": WorkbenchThreadIdSchema.parse("root-thread"),
  "snooze-question": WorkbenchThreadIdSchema.parse("snooze-question"),
  "source": WorkbenchThreadIdSchema.parse("source"),
  "stale": WorkbenchThreadIdSchema.parse("stale"),
  "target": WorkbenchThreadIdSchema.parse("target"),
  "terminal": WorkbenchThreadIdSchema.parse("terminal"),
  "thread": WorkbenchThreadIdSchema.parse("thread"),
  "top": WorkbenchThreadIdSchema.parse("top"),
  "waiting-thread": WorkbenchThreadIdSchema.parse("waiting-thread"),
  "working": WorkbenchThreadIdSchema.parse("working"),
};

type TestControllerOptions = Omit<WorkbenchThreadStateControllerOptions, "resolveProjectId" | "hasGitArcBlockingSettlement" | "resolveGitArc" | "resolveGitArcPlan" | "runGitArcReadTransition" | "threadStateStore">
  & Partial<Pick<WorkbenchThreadStateControllerOptions, "resolveProjectId" | "hasGitArcBlockingSettlement" | "resolveGitArc" | "resolveGitArcPlan" | "runGitArcReadTransition" | "threadStateStore">>
  & {
    storageRoot: string;
    onProject?: (snapshot: WorkbenchThreadSidebarSnapshot) => void;
  };

class MemoryThreadStatePersistence implements WorkbenchThreadStatePersistence {
  readonly globals = new Map<WorkbenchThreadStateGlobalDocumentId, object>();
  readonly projects = new Map<ProjectId, object>();
  readonly titleHistories = new Map<string, WorkbenchStoredThreadTitleHistory[]>();

  async writeChanges(projectId: ProjectId, changes: Parameters<WorkbenchThreadStatePersistence["writeChanges"]>[1]) {
    const document = parseProjectDocument(JSON.stringify(this.projects.get(projectId) ?? { version: 4, records: [], drafts: [] }), projectId);
    const records = new Map(document.records.map(record => [record.identity.threadId, record]));
    for (const record of changes.records ?? []) records.set(record.identity.threadId, record);
    for (const threadId of changes.deletedThreadIds ?? []) records.delete(threadId);
    const drafts = new Map(document.drafts.map(draft => [draft.draftId, draft]));
    for (const stored of changes.drafts ?? []) drafts.set(stored.draft.draftId, { ...stored.draft, pinned: stored.pinned, snoozed: stored.snoozed });
    for (const draftId of changes.deletedDraftIds ?? []) drafts.delete(draftId);
    const histories = new Map((this.titleHistories.get(projectId) ?? []).map(history => [history.identity.threadId, history]));
    for (const record of changes.records ?? []) {
      if (record.titleHistory !== undefined) histories.set(record.identity.threadId, { identity: record.identity, titles: record.titleHistory });
    }
    const layout = changes.layouts?.find(layout => layout.owner.kind === "project" && layout.owner.projectId === projectId);
    const profile = changes.projectProfiles?.find(profile => profile.projectId === projectId);
    this.projects.set(projectId, structuredClone({
      ...document, version: 4, records: [...records.values()], drafts: [...drafts.values()],
      ...(layout ? { displayOrder: layout.displayOrder } : {}),
      ...(profile ? { newThreadProfile: profile.profile } : {}),
    }));
    this.titleHistories.set(projectId, structuredClone([...histories.values()]));
  }

  async readArchiveEligible(activeBefore: number) {
    return [...this.projects].flatMap(([projectId, document]) =>
      parseProjectDocument(JSON.stringify(document), projectId).records
        .filter(record => record.entryKind === "thread" && record.lifecycle.settled
          && !record.metadata.archived && !record.metadata.pinned && record.activityAt <= activeBefore)
        .map(record => ({ projectId, record })));
  }

  async readNextArchiveEligibility() {
    const records = await this.readArchiveEligible(Number.MAX_SAFE_INTEGER);
    return records.length ? Math.min(...records.map(({ record }) => record.activityAt)) : null;
  }

  async readTitleHistories(projectId: string) {
    return structuredClone(this.titleHistories.get(projectId) ?? []);
  }

  async readGlobal(id: WorkbenchThreadStateGlobalDocumentId) {
    return structuredClone(this.globals.get(id) ?? null);
  }

  async readProject(projectId: string) {
    return structuredClone(this.projects.get(ProjectIdSchema.parse(projectId)) ?? null);
  }

  async readNavigationSummary(projectId: ProjectId) {
    const stored = parseProjectDocument(JSON.stringify(this.projects.get(projectId)
      ?? { version: 4, records: [], drafts: [] }), projectId);
    return createWorkbenchProjectThreadSummary(projectId, [
      ...stored.records.flatMap(record => {
        const entry = projectWorkbenchThreadStateEntry(record);
        return entry ? [entry] : [];
      }),
      ...stored.drafts.filter(draft => draft.pinned && !draft.snoozed).map(draft =>
        projectWorkbenchThreadDraft(draft, { archived: false, pinned: true, snoozed: false })),
    ], 0, stored.displayOrder ?? {});
  }

  async writeGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object) {
    this.globals.set(id, structuredClone(document));
  }

  async writeProject(projectId: string, document: object, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]) {
    this.projects.set(ProjectIdSchema.parse(projectId), structuredClone(document));
    if (titleHistories) this.titleHistories.set(projectId, structuredClone([...titleHistories]));
  }
}

const testPersistenceByRoot = new Map<string, MemoryThreadStatePersistence>();

test("retained project reads and mutations use canonical ownership without creating alias storage", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const persistence = new MemoryThreadStatePersistence();
  const source = testProjectIds.project;
  const destination = testProjectIds.other;
  const controller = new WorkbenchThreadStateController({
    storageRoot: "canonical-project-requests", threadStateStore: persistence,
    resolveProjectId: id => {
      if (id === fixtureProjectIds.alpha || id === source) return source;
      if (id === fixtureProjectIds.beta || id === destination) return destination;
      throw new Error("Project ownership has not been admitted.");
    },
    getProjectCatalog: () => ({ data: [projectOption(source, "C:/source"), projectOption(destination, "C:/destination")], rootPath: "C:/" }),
    reconcileProject: async () => [],
  });
  try {
    const opened = await controller.readProject(fixtureProjectIds.alpha);
    assert.equal(opened.projectId, source);
    const before = structuredClone({ projects: persistence.projects, globals: persistence.globals });
    for (const id of ["remote:/example.test/source", "remote://example.test/unknown"]) {
      await assert.rejects(controller.readProject(ProjectIdSchema.parse(id)), /project/i);
    }
    assert.deepEqual({ projects: persistence.projects, globals: persistence.globals }, before);
    const entry = pinnedRecord("thread", "retained");
    await controller.ensureProviderEntry(fixtureProjectIds.alpha, entry);
    assert.equal((await controller.getSnapshot(source)).entries.length, 1);
    assert.ok(!persistence.projects.has(fixtureProjectIds.alpha));
    await controller.handleRequest("connection", {
      method: "workbench/thread-state/pin/set", projectId: fixtureProjectIds.alpha,
      identity: entry.identity, pinned: false,
    });
    assert.equal(controller.peekProject(fixtureProjectIds.alpha)?.projectId, source);
    assert.equal((await controller.getProjectThreadSummary(fixtureProjectIds.alpha)).projectId, source);
    assert.equal((await controller.readProject(destination)).entries.length, 0);
  } finally { await controller.dispose(); }
});

test("thread mutations do not replace their project document", async () => {
  const persistence = new MemoryThreadStatePersistence();
  const controller = new WorkbenchThreadStateController({
    storageRoot: "isolated-thread-writes", threadStateStore: persistence,
    getProjectCatalog: () => ({ data: [], rootPath: "" }), reconcileProject: async () => [],
  });
  const provider = normalizeProviderSidebarEntry("codex", { id: "isolated", name: "original", updatedAt: 1 });
  assert.ok(provider && provider.entryKind === "thread");
  try {
    await controller.ensureProviderEntry(fixtureProjectIds["project"], provider);
    const neighbour = normalizeProviderSidebarEntry("copilot", { id: "neighbour", name: "untouched", updatedAt: 1 });
    assert.ok(neighbour && neighbour.entryKind === "thread");
    await controller.ensureProviderEntry(fixtureProjectIds["project"], neighbour);
    await controller.setComposerProfileTarget({ kind: "thread", projectId: fixtureProjectIds["project"], ...provider.identity }, {
      kind: "custom", settings: { ...EMPTY_CODEX_SETTINGS, model: "isolated-model" },
    });
    await controller.refresh(fixtureProjectIds["project"]);
    await controller.readProject(fixtureProjectIds["project"]);
    const writeChanges = persistence.writeChanges.bind(persistence);
    persistence.writeChanges = async (projectId, changes) => {
      assert.ok(changes.records?.every(record => record.identity.threadId === provider.identity.threadId) ?? true,
        "an unrelated thread entered the operation's write");
      assert.equal(changes.projectProfiles, undefined);
      assert.equal(changes.drafts, undefined);
      await writeChanges(projectId, changes);
    };
    persistence.writeProject = async () => { throw new Error("unrelated project records entered a thread write"); };
    const profile = await controller.prepareComposerProfileTarget({
      kind: "thread", projectId: fixtureProjectIds["project"], ...provider.identity,
    });
    assert.equal(profile.selection.settings.model, "isolated-model");
    await controller.setTitle(fixtureProjectIds["project"], "codex", provider.identity.threadId, "renamed");
    await controller.setMcpGeneration(fixtureProjectIds["project"], "codex", provider.identity.threadId, "generation");
    assert.equal(await controller.getMcpGeneration(fixtureProjectIds["project"], "codex", provider.identity.threadId), "generation");
    for (const request of [
      { method: "workbench/thread-state/priority/set" as const, sourceKey: getThreadDisplayThreadKey("codex", provider.identity.threadId), priority: "pinned" as const },
      { method: "workbench/thread-state/status/set" as const, identity: provider.identity, status: "completed" as const },
      { method: "workbench/thread-state/settle" as const, identity: provider.identity },
    ]) {
      const response = await controller.handleRequest("isolated-viewer", { ...request, projectId: fixtureProjectIds["project"] });
      assert.equal(response.error, undefined);
    }
    const document = parseProjectDocument(JSON.stringify(await persistence.readProject("project")), fixtureProjectIds["project"]);
    assert.equal(document.records.find(record => record.identity.threadId === neighbour.identity.threadId)?.title, "untouched");
    assert.equal(document.records.find(record => record.identity.threadId === provider.identity.threadId)?.lifecycle.settled, true);
  } finally {
    await controller.dispose();
  }
});

test("failed provider installation does not leave a new entry in project memory", async () => {
  const persistence = new MemoryThreadStatePersistence();
  const controller = new WorkbenchThreadStateController({
    storageRoot: "failed-provider-install", threadStateStore: persistence,
    getProjectCatalog: () => ({ data: [], rootPath: "" }), reconcileProject: async () => [],
  });
  const provider = normalizeProviderSidebarEntry("codex", { id: "rejected-install", name: "rejected", updatedAt: 1 });
  assert.ok(provider && provider.entryKind === "thread");
  try {
    await controller.getSnapshot(fixtureProjectIds["project"]);
    await controller.refresh(fixtureProjectIds["project"]);
    persistence.writeChanges = async () => { throw new Error("storage rejected installation"); };
    await assert.rejects(controller.ensureProviderEntry(fixtureProjectIds["project"], provider), /storage rejected installation/);
    assert.equal(await controller.getThreadEntry(fixtureProjectIds["project"], "codex", provider.identity.threadId), null);
  } finally {
    await controller.dispose();
  }
});

test("a queued title write retains the profile committed ahead of it", async () => {
  const persistence = new MemoryThreadStatePersistence();
  let enter!: () => void;
  let release!: () => void;
  let titleStarted!: () => void;
  const writing = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const titleStarting = new Promise<void>(resolve => { titleStarted = resolve; });
  let onNow = () => {};
  const controller = new WorkbenchThreadStateController({
    storageRoot: "queued-thread-facts", threadStateStore: persistence,
    now: () => { onNow(); return 10; },
    getProjectCatalog: () => ({ data: [], rootPath: "" }), reconcileProject: async () => [],
  });
  const provider = normalizeProviderSidebarEntry("codex", { id: "queued-profile", name: "original", updatedAt: 1 });
  assert.ok(provider && provider.entryKind === "thread");
  try {
    await controller.ensureProviderEntry(fixtureProjectIds["project"], provider);
    await controller.refresh(fixtureProjectIds["project"]);
    const write = persistence.writeChanges.bind(persistence);
    let first = true;
    persistence.writeChanges = async (projectId, changes) => {
      if (first) { first = false; enter(); await gate; }
      await write(projectId, changes);
    };
    const selection = { kind: "custom" as const, settings: { ...EMPTY_CODEX_SETTINGS, model: "new-profile" } };
    const profileSave = controller.setComposerProfileTarget({
      kind: "thread", projectId: fixtureProjectIds["project"], ...provider.identity,
    }, selection);
    await writing;
    onNow = titleStarted;
    const titleSave = controller.setTitle(fixtureProjectIds["project"], "codex", provider.identity.threadId, "new title");
    await titleStarting;
    release();
    await Promise.all([profileSave, titleSave]);
    const document = parseProjectDocument(JSON.stringify(await persistence.readProject("project")), fixtureProjectIds["project"]);
    assert.equal(document.records[0]?.title, "new title");
    assert.deepEqual(document.records[0]?.profile, selection);
  } finally {
    release();
    await controller.dispose();
  }
});

test("failed discovery rollback preserves a newer title and its eventual save", async () => {
  const persistence = new MemoryThreadStatePersistence();
  let enter!: () => void;
  let release!: () => void;
  let titleStarted!: () => void;
  const writing = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const titleStarting = new Promise<void>(resolve => { titleStarted = resolve; });
  const provider = normalizeProviderSidebarEntry("codex", { id: "discovery-race", name: "original", updatedAt: 1 });
  assert.ok(provider && provider.entryKind === "thread");
  let discover = false;
  let onNow = () => {};
  const controller = new WorkbenchThreadStateController({
    storageRoot: "discovery-write-race", threadStateStore: persistence,
    now: () => { onNow(); return 10; },
    getProjectCatalog: () => ({ data: [], rootPath: "" }),
    reconcileProject: async (_projectId, _signal, accept) => {
      if (discover) await accept("codex", [{ ...provider, title: "discovery title" }], { complete: false });
      return [];
    },
  });
  try {
    await controller.ensureProviderEntry(fixtureProjectIds["project"], provider);
    await controller.refresh(fixtureProjectIds["project"]);
    const write = persistence.writeChanges.bind(persistence);
    let first = true;
    persistence.writeChanges = async (projectId, changes) => {
      if (first) { first = false; enter(); await gate; throw new Error("discovery save failed"); }
      await write(projectId, changes);
    };
    discover = true;
    const refresh = controller.refresh(fixtureProjectIds["project"]);
    await writing;
    onNow = titleStarted;
    const titleSave = controller.setTitle(fixtureProjectIds["project"], "codex", provider.identity.threadId, "newer title");
    await titleStarting;
    release();
    await Promise.all([refresh, titleSave]);
    assert.equal((await controller.getThreadEntry(fixtureProjectIds["project"], "codex", provider.identity.threadId))?.title, "newer title");
    const document = parseProjectDocument(JSON.stringify(await persistence.readProject("project")), fixtureProjectIds["project"]);
    assert.equal(document.records[0]?.title, "newer title");
    assert.match((await controller.getSnapshot(fixtureProjectIds["project"])).error ?? "", /discovery save failed/);
  } finally {
    release();
    await controller.dispose();
  }
});

for (const scope of ["project", "global"] as const) {
  test(`retiring thread state fences ${scope} storage reads before repair writes`, async () => {
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: (value: null) => void;
    const gate = new Promise<null>(resolve => { release = resolve; });
    const persistence = new MemoryThreadStatePersistence();
    if (scope === "project") persistence.readProject = async () => { enter(); return await gate; };
    else persistence.readGlobal = async () => { enter(); return await gate; };
    const controller = new WorkbenchThreadStateController({
      storageRoot: `retired-${scope}`, threadStateStore: persistence,
      getProjectCatalog: () => ({ data: [], rootPath: "" }),
      reconcileProject: async () => [],
    });
    const reading = controller.getSnapshot(fixtureProjectIds["project"]);
    const rejected = assert.rejects(reading, /retired/);
    await entered;
    const writesBeforeRetirement = persistence.projects.size + persistence.globals.size;
    const disposing = controller.dispose();
    await disposing;
    release(null);
    await rejected;
    assert.equal(persistence.projects.size + persistence.globals.size, writesBeforeRetirement);
  });
}

test("thread-state retirement retains an already-issued document write", async () => {
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const persistence = new MemoryThreadStatePersistence();
  const write = persistence.writeProject.bind(persistence);
  persistence.writeProject = async (...args) => { enter(); await gate; await write(...args); };
  const controller = new WorkbenchThreadStateController({
    storageRoot: "retired-issued-write", threadStateStore: persistence,
    getProjectCatalog: () => ({ data: [], rootPath: "" }),
    reconcileProject: async () => [],
  });
  const reading = controller.getSnapshot(fixtureProjectIds["project"]);
  const settlement = Promise.allSettled([reading]);
  await entered;
  let disposed = false;
  const disposing = controller.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  release();
  await disposing;
  await settlement;
  assert.equal(persistence.projects.has(fixtureIdentitySchemas.ProjectIdSchema.parse("project")), true);
});

test("first explicit title is durable before a rename and keeps its timestamp after restart", async () => {
  const persistence = new MemoryThreadStatePersistence();
  const identity = { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("existing-thread") };
  await persistence.writeProject("project", {
    drafts: [],
    records: [{
      activityAt: 1,
      entryKind: "thread",
      identity,
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
      title: "existing title",
    }],
    version: 4,
  });
  const options: TestControllerOptions = {
    storageRoot: "initial-title-history",
    threadStateStore: persistence,
    now: () => 10,
    getProjectCatalog: () => ({ data: [], rootPath: "" }),
    reconcileProject: async () => [],
  };
  const first = new WorkbenchThreadStateController(options);
  try {
    await first.getSnapshot(fixtureProjectIds["project"]);
    const observed = normalizeProviderSidebarEntry("codex", { id: identity.threadId, name: "existing title", updatedAt: 1 });
    assert.ok(observed && observed.entryKind !== "draft");
    await first.ensureProviderEntry(fixtureProjectIds["project"], observed);
    assert.deepEqual((await persistence.readTitleHistories("project")).flatMap((row) => row.titles), []);
    await first.setTitle(fixtureProjectIds["project"], "codex", identity.threadId, "existing title");
    assert.deepEqual(await persistence.readTitleHistories("project"), [{
      identity, titles: [{ title: "existing title", usedAt: 10 }],
    }]);
  } finally {
    await first.dispose();
  }
  const restarted = new WorkbenchThreadStateController({ ...options, now: () => 20 });
  try {
    await restarted.setTitle(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId), "next title");
    const entry = (await restarted.getSnapshot(fixtureProjectIds["project"])).entries[0]!;
    assert.deepEqual("previousTitles" in entry ? entry.previousTitles : undefined, [{ title: "existing title", usedAt: 10 }]);
  } finally {
    await restarted.dispose();
  }
});

test("title history records user renames, ignores repeated observations, and survives reconciliation", async () => {
  let now = 10;
  const controller = new WorkbenchThreadStateController({
    storageRoot: "title-history-owner",
    now: () => now,
    getProjectCatalog: () => ({ data: [], rootPath: "" }),
    reconcileProject: async () => [],
    renameThread: async (_project, _harness, _thread, title) => {
      if (title === "rejected") throw new Error("Provider rejected rename.");
      return title;
    },
  });
  const provider: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["history-thread"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "original",
  };
  try {
    await controller.readProject(fixtureProjectIds["project"]);
    const originalProvider = normalizeProviderSidebarEntry("codex", { id: provider.identity.threadId, name: provider.title, updatedAt: 1 });
    assert.ok(originalProvider && originalProvider.entryKind !== "draft");
    await controller.ensureProviderEntry(fixtureProjectIds["project"], originalProvider);
    await controller.setTitle(fixtureProjectIds["project"], "codex", fixtureThreadIds["history-thread"], "original");
    now = 20;
    const renamed = await controller.handleRequest("viewer", {
      method: "workbench/thread-state/title/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: provider.identity, title: "renamed",
    });
    assert.equal(renamed.error, undefined);
    const snapshot = () => controller.getSnapshot(fixtureProjectIds["project"]);
    const renamedEntry = (await snapshot()).entries[0]!;
    assert.deepEqual("previousTitles" in renamedEntry ? renamedEntry.previousTitles : undefined, [{ title: "original", usedAt: 10 }]);
    now = 30;
    await controller.observeDisplayLabel("codex", fixtureThreadIds["history-thread"], "renamed");
    const renamedProvider = normalizeProviderSidebarEntry("codex", { id: provider.identity.threadId, name: "renamed", updatedAt: 1 });
    assert.ok(renamedProvider && renamedProvider.entryKind !== "draft");
    await controller.ensureProviderEntry(fixtureProjectIds["project"], renamedProvider);
    assert.deepEqual((await snapshot()).entries[0], renamedEntry);
    const rejected = await controller.handleRequest("viewer", {
      method: "workbench/thread-state/title/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: provider.identity, title: "rejected",
    });
    assert.equal(rejected.error?.code, "threadTitleMutationFailed");
    assert.deepEqual((await snapshot()).entries[0], renamedEntry);
    const dismissRequest = {
      method: "workbench/thread-state/title/dismiss" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: provider.identity, title: "original",
    };
    const dismissed = await controller.handleRequest("another-socket", dismissRequest);
    assert.equal(dismissed.error, undefined);
    await controller.ensureProviderEntry(fixtureProjectIds["project"], renamedProvider);
    const afterDismissal = (await snapshot()).entries[0]!;
    assert.deepEqual("previousTitles" in afterDismissal ? afterDismissal.previousTitles : undefined, []);
    now = 40;
    await controller.setTitle(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("history-thread"), "original");
    const reapplied = (await snapshot()).entries[0]!;
    assert.deepEqual("previousTitles" in reapplied ? reapplied.previousTitles : undefined, [{ title: "renamed", usedAt: 20 }]);
  } finally {
    await controller.dispose();
  }
});

test("fallback displays never enter history through load, reconciliation, lifecycle, or rename", async () => {
  const persistence = new MemoryThreadStatePersistence();
  const identity = { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("fallback-thread") };
  const fallback = normalizeProviderSidebarEntry("codex", { id: identity.threadId, updatedAt: 1 });
  assert.ok(fallback && fallback.entryKind !== "draft");
  await persistence.writeProject("project", { drafts: [], records: [fallback], version: 4 });
  const options: TestControllerOptions = {
    storageRoot: "fallback-title-history",
    threadStateStore: persistence,
    now: () => 10,
    getProjectCatalog: () => ({ data: [], rootPath: "" }),
    reconcileProject: async () => [],
  };
  const first = new WorkbenchThreadStateController(options);
  try {
    await first.getSnapshot(fixtureProjectIds["project"]);
    assert.deepEqual((await persistence.readTitleHistories("project")).flatMap((row) => row.titles), []);
    await first.ensureProviderEntry(fixtureProjectIds["project"], fallback);
    const preview = normalizeProviderSidebarEntry("codex", { id: identity.threadId, preview: "first user request", updatedAt: 2 });
    assert.ok(preview && preview.entryKind !== "draft");
    await first.ensureProviderEntry(fixtureProjectIds["project"], preview);
    await first.applyLifecycle(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId), { kind: "acceptedIntent", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }, preview);
    assert.deepEqual((await persistence.readTitleHistories("project")).flatMap((row) => row.titles), []);
    const named = normalizeProviderSidebarEntry("codex", { id: identity.threadId, name: "provider name", updatedAt: 3 });
    assert.ok(named && named.entryKind !== "draft");
    await first.ensureProviderEntry(fixtureProjectIds["project"], named);
    assert.deepEqual((await persistence.readTitleHistories("project")).flatMap((row) => row.titles), []);
    assert.equal(
      (await first.getThreadEntry(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId)))?.title,
      "provider name",
    );
    await first.setTitle(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId), "actual name");
    assert.deepEqual((await persistence.readTitleHistories("project")).flatMap((row) => row.titles), [{ title: "actual name", usedAt: 10 }]);
  } finally {
    await first.dispose();
  }
  const restarted = new WorkbenchThreadStateController({ ...options, now: () => 20 });
  try {
    await restarted.setTitle(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId), "first user request");
    const entry = (await restarted.getSnapshot(fixtureProjectIds["project"])).entries[0]!;
    assert.deepEqual("previousTitles" in entry ? entry.previousTitles : undefined, [{ title: "actual name", usedAt: 10 }]);
    assert.deepEqual((await persistence.readTitleHistories("project")).flatMap((row) => row.titles), [
      { title: "first user request", usedAt: 20 }, { title: "actual name", usedAt: 10 },
    ]);
  } finally {
    await restarted.dispose();
  }
});

test("renaming to a drifted provider label still advances the recorded title", async () => {
  let now = 10;
  const controller = new WorkbenchThreadStateController({
    storageRoot: "explicit-title-drift-rename",
    now: () => now,
    getProjectCatalog: () => ({ data: [], rootPath: "" }),
    reconcileProject: async () => [],
  });
  const identity = { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("drift-thread") };
  const entry = async () => (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find(
    (candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === identity.threadId,
  )!;
  const providerEntry = (name: string) => {
    const observed = normalizeProviderSidebarEntry("codex", { id: identity.threadId, name, updatedAt: 1 });
    assert.ok(observed && observed.entryKind === "thread");
    return observed;
  };
  try {
    await controller.readProject(fixtureProjectIds["project"]);
    await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry("A"));
    await controller.setTitle(fixtureProjectIds["project"], "codex", identity.threadId, "A");
    now = 20;
    await controller.setTitle(fixtureProjectIds["project"], "codex", identity.threadId, "B");
    now = 30;
    // The provider reports the older explicit title back as a display label.
    await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry("A"));
    assert.equal((await entry()).title, "B");
    now = 40;
    await controller.setTitle(fixtureProjectIds["project"], "codex", identity.threadId, "A");
    const renamed = await entry();
    assert.equal(renamed.title, "A");
    assert.deepEqual("previousTitles" in renamed ? renamed.previousTitles : undefined, [{ title: "B", usedAt: 20 }]);
  } finally {
    await controller.dispose();
  }
});

test("dismissal protects the recorded title rather than a drifted provider label", async () => {
  let now = 10;
  const controller = new WorkbenchThreadStateController({
    storageRoot: "explicit-title-drift-dismiss",
    now: () => now,
    getProjectCatalog: () => ({ data: [], rootPath: "" }),
    reconcileProject: async () => [],
  });
  const identity = { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("drift-dismiss-thread") };
  const entry = async () => (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find(
    (candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === identity.threadId,
  )!;
  const providerEntry = (name: string) => {
    const observed = normalizeProviderSidebarEntry("codex", { id: identity.threadId, name, updatedAt: 1 });
    assert.ok(observed && observed.entryKind === "thread");
    return observed;
  };
  const dismiss = (title: string) => controller.handleRequest("viewer", {
    method: "workbench/thread-state/title/dismiss", projectId: fixtureProjectIds["project"], identity, title,
  });
  try {
    await controller.readProject(fixtureProjectIds["project"]);
    await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry("A"));
    await controller.setTitle(fixtureProjectIds["project"], "codex", identity.threadId, "A");
    now = 20;
    await controller.setTitle(fixtureProjectIds["project"], "codex", identity.threadId, "B");
    now = 30;
    await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry("A"));
    const protectedCurrent = await dismiss("B");
    assert.equal(protectedCurrent.error, undefined);
    assert.equal((protectedCurrent.result as { accepted?: boolean } | undefined)?.accepted, false);
    const driftedLabel = await dismiss("A");
    assert.equal(driftedLabel.error, undefined);
    assert.equal((driftedLabel.result as { accepted?: boolean } | undefined)?.accepted, true);
    assert.equal((await entry()).title, "B");
  } finally {
    await controller.dispose();
  }
});

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
      onProject,
      threadStateStore = testPersistence(storageRoot),
      ...controllerOptions
    } = options;
    super({
      resolveProjectId: id => id,
      hasGitArcBlockingSettlement: async () => false,
      resolveGitArc: async () => null,
      resolveGitArcPlan: async () => null,
      runGitArcReadTransition: async (_projectId, operation) => await operation(),
      ...controllerOptions,
      threadStateStore,
    });
    if (onProject) this.subscribeProjects(projectId => {
      const snapshot = this.peekProject(projectId);
      if (snapshot) onProject(snapshot);
    });
  }
}

function projectCatalog() {
  return { data: [], rootPath: "C:/projects" };
}

function projectOption(id: string, rootPath: string) {
  return {
    id: ProjectIdSchema.parse(id),
    kind: "git" as const,
    lastCommitTimeMs: null,
    name: id,
    relativePath: id,
    rootPath,
    roots: [{ id, isPrimary: true, name: id, relativePath: id, rootPath }],
  };
}

test("settlement publishes the affected entry while discovery is held, including headless subscribers", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const publications: WorkbenchThreadSidebarSnapshot[] = [];
  const observed: WorkbenchThreadSidebarEntry[] = [];
  const controller = new WorkbenchThreadStateController({
    storageRoot: "immediate-incremental-settlement",
    getProjectCatalog: () => ({ data: [projectOption("project", "C:/project")], rootPath: "C:/" }),
    onProject: snapshot => publications.push(snapshot),
    reconcileProject: async () => { entered(); await gate; return []; },
  });
  let refreshing: Promise<WorkbenchThreadSidebarSnapshot> | null = null;
  try {
    for (const threadId of ["changed", "unrelated"]) await controller.ensureProviderEntry(fixtureProjectIds["project"], {
      entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) }, activityAt: 1, title: threadId,
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "completed", reason: "userCompleted", settled: false },
    });
    await controller.readProject(fixtureProjectIds["project"]);
    refreshing = controller.refresh(fixtureProjectIds["project"]);
    await started;
    publications.length = 0;
    await controller.handleRequest("viewer", {
      method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("changed") },
    });
    const settled = publications.at(-1)?.entries.find(entry => entry.entryKind !== "draft" && entry.identity.threadId === "changed");
    assert.ok(settled && settled.entryKind !== "draft" && settled.lifecycle.settled);
    publications.length = 0;
    await controller.handleRequest("viewer", {
      method: "workbench/thread-state/priority/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), sourceKey: "codex:unrelated", priority: "pinned",
    });
    const priority = publications.at(-1)?.entries.find(entry => entry.entryKind !== "draft" && entry.identity.threadId === "unrelated");
    assert.ok(priority?.entryKind === "thread" && priority.metadata.pinned);
    publications.length = 0;
    await controller.setTitle(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("unrelated"), "visible title");
    const title = publications.at(-1)?.entries.find(entry => entry.entryKind !== "draft" && entry.identity.threadId === "unrelated");
    assert.equal(title?.title, "visible title");
    const stop = controller.subscribe((_projectId, entry) => observed.push(entry));
    await controller.setTitle(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("unrelated"), "headless change");
    stop();
    assert.equal(observed.at(-1)?.title, "headless change");
  } finally {
    release();
    await refreshing;
    await controller.dispose();
  }
});

test("a demanded thread read includes questionnaire state independently of project discovery failure", async () => {
  const identity = { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("foreign-thread") };
  const provider: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1, entryKind: "thread", title: "Foreign", identity,
    metadata: { archived: false, pinned: true, snoozed: false },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
  };
  const controller = new WorkbenchThreadStateController({
    storageRoot: "foreign-thread-observation",
    threadStateStore: new MemoryThreadStatePersistence(),
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/alpha"), projectOption("beta", "C:/beta")],
      rootPath: "C:/",
    }),
    reconcileProject: async () => [{ harness: "opencode", message: "Unrelated provider is unavailable." }],
  });
  try {
    await controller.ensureProviderEntry(fixtureProjectIds["beta"], provider);
    await controller.refresh(fixtureProjectIds["beta"]);
    await controller.readProject(fixtureProjectIds["alpha"]);
    const subscriptionId = "4f603f09-c04c-43ab-b879-6fbe4133b94a";
    const read = () => controller.readWorkspaceThread({
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
      subscriptionId,
      target: { kind: "provider", ...identity },
    });
    const result = await read();
    assert.equal(result.entries[0]?.entryKind, "thread");
    assert.equal(result.error, null);
    assert.equal(result.freshness, "fresh");
    assert.ok((await controller.getSnapshot(fixtureProjectIds["beta"])).error, "the project retains its own reconciliation failure");
    const question = {
      itemId: "6f78b24c-db99-4161-a768-40f1cab6b58d",
      requestKey: "pending",
      turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
      request: { id: "question", title: "Continue?", summary: "", submitLabel: "Send", questions: [
        { id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false },
      ] },
    };
    await controller.observeLifecycle("codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId), {
      kind: "pendingInput", questionnaire: question, requestKey: question.requestKey, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(question.turnId),
    });
    const pending = (await read()).entries[0];
    assert.ok(pending && pending.entryKind !== "draft");
    assert.deepEqual(pending.pendingQuestionnaire, question);
    await controller.observeLifecycle("codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId), { kind: "inputResolved", requestKey: question.requestKey });
    const cleared = (await read()).entries[0];
    assert.ok(cleared && cleared.entryKind !== "draft");
    assert.equal(cleared.pendingQuestionnaire, null);
  } finally {
    await controller.dispose();
  }
});

async function readProjectState<T extends object>(storageRoot: string, projectId: string) {
  return await testPersistence(storageRoot).readProject(projectId) as T;
}

test("accepted questionnaire response returns its thread to working", async () => {
  const notices: string[] = [];
  const question = {
    itemId: "b5bf699f-ea4b-45cf-9583-7449b536ea44",
    requestKey: "request",
    turnId: fixtureTurnIds["turn"],
    request: {
      id: "request",
      title: "Choose",
      summary: "",
      submitLabel: "Submit",
      questions: [{ id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false }],
    },
  };
  const provider: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    title: "Task",
    identity: { harness: "codex", threadId: fixtureThreadIds["thread"] },
    metadata: { archived: false, pinned: false, snoozed: false },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: question.requestKey, settled: false },
    pendingQuestionnaire: question,
  };
  const controller = new WorkbenchThreadStateController({
    storageRoot: "accepted-questionnaire-working",
    publishAgentContext: async (_harness, _threadId, text) => { notices.push(text); },
    threadStateStore: new MemoryThreadStatePersistence(),
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_project, _signal, accept) => {
      await accept("codex", [provider], { complete: true });
      return [];
    },
  });
  try {
    await controller.readProject(fixtureProjectIds["project"]);
    await controller.refresh(fixtureProjectIds["project"]);
    const response = { answers: { choice: { answers: ["yes"] } } };
    const result = await controller.resolvePendingQuestionnaire({
      harness: "codex",
      projectId: fixtureProjectIds["project"],
      requestKey: question.requestKey,
      resolvedAt: 2,
      response,
      threadId: fixtureThreadIds["thread"],
    }, async () => ({
      delivery: "delivered",
      insertAfterItemId: null,
      insertAfterItemIndex: null,
      turnId: question.turnId,
    }));

    assert.equal(result?.delivery, "delivered");
    assert.equal(notices.length, 1);
    const current = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find(
      entry => entry.entryKind === "thread" && entry.identity.threadId === fixtureThreadIds["thread"],
    );
    assert.deepEqual(current?.entryKind === "thread" ? current.lifecycle : null, {
      agent: { agentStatus: "working", turnId: question.turnId },
      kind: "working",
      reason: "acceptedIntent",
      settled: false,
    });
    assert.equal(current?.entryKind === "thread" ? current.pendingQuestionnaire : null, null);
    assert.deepEqual(current?.entryKind === "thread" ? current.questionnaireHistory?.[0]?.response : null, response);

    const replacement = {
      ...question,
      itemId: "984090b6-1d94-44cc-ab26-e6470965597e",
      requestKey: "replacement",
      turnId: question.turnId,
    };
    await controller.observeLifecycle("codex", fixtureThreadIds["thread"], {
      kind: "pendingInput",
      questionnaire: replacement,
      requestKey: replacement.requestKey,
      turnId: replacement.turnId,
    });
    await controller.resolvePendingQuestionnaire({
      harness: "codex",
      projectId: fixtureProjectIds["project"],
      requestKey: replacement.requestKey,
      resolvedAt: 3,
      response,
      threadId: fixtureThreadIds["thread"],
    }, async () => {
      await controller.applyLifecycle(
        fixtureProjectIds["project"],
        "codex",
        fixtureThreadIds["thread"],
        { kind: "userStopped" },
      );
      return {
        delivery: "delivered",
        insertAfterItemId: null,
        insertAfterItemIndex: null,
        turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("later-turn"),
      };
    });
    const stopped = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find(
      entry => entry.entryKind === "thread" && entry.identity.threadId === fixtureThreadIds["thread"],
    );
    assert.deepEqual(stopped?.entryKind === "thread" ? stopped.lifecycle : null, {
      kind: "stopped",
      reason: "userMarkedStopped",
      settled: false,
    });
    assert.equal(stopped?.entryKind === "thread" ? stopped.pendingQuestionnaire : null, null);
    assert.equal(notices.length, 1);
  } finally {
    await controller.dispose();
  }
});

test("status notices follow committed input transitions, not repeats or notification success", async () => {
  const notices: string[] = [];
  const statesAtPublication: Array<string | null> = [];
  const warnings: string[] = [];
  const controller = new WorkbenchThreadStateController({
    storageRoot: "status-notices",
    threadStateStore: new MemoryThreadStatePersistence(),
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [],
    publishAgentContext: async (_harness, threadId, text) => {
      notices.push(text);
      const entry = await controller.getCanonicalThreadEntry(fixtureProjectIds.project, threadId);
      statesAtPublication.push(entry?.entryKind === "thread" ? entry.lifecycle.kind : null);
      throw new Error("notification rejected");
    },
    log: message => { warnings.push(message); },
  });
  try {
    const entry = pinnedRecord("thread", "Task");
    await controller.ensureProviderEntry(fixtureProjectIds.project, entry);
    for (const status of ["blocked", "completed"] as const) {
      await controller.applyLifecycle(fixtureProjectIds.project, "codex", fixtureThreadIds.thread, { kind: "agentStatus", status });
      await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.thread, fixtureTurnIds.turn);
      await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.thread, fixtureTurnIds.turn);
    }
    const { metadata: _metadata, ...common } = entry;
    await controller.ensureProviderEntry(fixtureProjectIds.project, {
      ...common, entryKind: "subagent", identity: { harness: "codex", threadId: fixtureThreadIds.child },
      createdAt: 1, updatedAt: 1, cwd: "C:/workspace", directSubagentIndex: 0,
      name: "child", parentThreadId: fixtureThreadIds.thread, pinned: false,
      profileId: "profile", profileName: "profile", projectId: fixtureProjectIds.project,
    });
    await controller.applyLifecycle(fixtureProjectIds.project, "codex", fixtureThreadIds.child, { kind: "agentStatus", status: "blocked" });
    await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.child, fixtureTurnIds.turn);
    assert.equal(notices.length, 2);
    assert.deepEqual(statesAtPublication, ["working", "working"]);
    assert.equal(warnings.length, 2);
    const entryAfter = await controller.getCanonicalThreadEntry(fixtureProjectIds.project, fixtureThreadIds.thread);
    assert.equal(entryAfter?.entryKind === "thread" ? entryAfter.lifecycle.kind : null, "working");
  } finally {
    await controller.dispose();
  }
});

test("questionnaire completion revalidates the captured item after interruption and never grants subagent authority", async () => {
  for (const outcome of ["complete", "replace", "fail", "subagent"] as const) {
    const question = {
      itemId: "b5bf699f-ea4b-45cf-9583-7449b536ea44", requestKey: "request", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
      request: { id: "request", title: "Choose", summary: "", submitLabel: "Submit", questions: [
        { id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false },
      ] },
    };
    const provider: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
      activityAt: 1, entryKind: "thread", title: "Task", identity: { harness: "codex", threadId: fixtureThreadIds["thread"] },
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "request", turnId: fixtureTurnIds["turn"], settled: false },
      pendingQuestionnaire: question,
    };
    let interrupts = 0;
    const { metadata: _metadata, ...common } = provider;
    const record: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> = outcome === "subagent" ? {
      ...common, entryKind: "subagent", createdAt: 1, updatedAt: 1, cwd: "C:/workspace", directSubagentIndex: 0,
      name: "child", parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent"), pinned: false, profileId: "profile", profileName: "profile", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    } : provider;
    const controller = new WorkbenchThreadStateController({
      storageRoot: `questionnaire-completion-${outcome}`, threadStateStore: new MemoryThreadStatePersistence(),
      getProjectCatalog: projectCatalog,
      reconcileProject: async (_project, _signal, accept) => {
        await accept("codex", [record], { complete: true });
        return [];
      },
      interruptQuestionnaire: async () => {
        interrupts++;
        if (outcome === "fail") throw new Error("stop failed");
        if (outcome === "replace") await controller.observeLifecycle("codex", fixtureThreadIds["thread"], {
          kind: "pendingInput", requestKey: "request", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
          questionnaire: { ...question, itemId: "984090b6-1d94-44cc-ab26-e6470965597e" },
        });
        return true;
      },
    });
    try {
      await controller.readProject(fixtureProjectIds["project"]);
      await controller.refresh(fixtureProjectIds["project"]);
      await controller.ensureProviderEntry(fixtureProjectIds["project"], record);
      await controller.observeLifecycle("codex", fixtureThreadIds["thread"], {
        kind: "pendingInput", questionnaire: question, requestKey: question.requestKey, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(question.turnId),
      });
      const completing = controller.handleRequest("observer", {
        method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: provider.identity, status: "completed",
      });
      if (outcome === "fail") await assert.rejects(completing, /stop failed/u);
      else {
        const response = await completing;
        assert.equal("result" in response && (response.result as { accepted: boolean }).accepted, outcome === "complete", outcome);
      }
      assert.equal(interrupts, outcome === "subagent" ? 0 : 1);
      const current = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find(entry => entry.entryKind !== "draft" && entry.identity.threadId === "thread");
      assert.equal(current?.entryKind !== "draft" && current?.lifecycle.kind, outcome === "complete" ? "completed" : "needsAttention");
      assert.ok(current && current.entryKind !== "draft" && current.pendingQuestionnaire);
    } finally { await controller.dispose(); }
  }
});

async function readGlobalState<T extends object>(storageRoot: string, id: WorkbenchThreadStateGlobalDocumentId) {
  return await testPersistence(storageRoot).readGlobal(id) as T;
}

test("overdue settlement archives retroactively except pinned threads and restore clears archival", async () => {
  const persistence = new MemoryThreadStatePersistence();
  const now = 20 * 24 * 60 * 60 * 1_000;
  const records = ["overdue", "pinned", "recent", "missing-time"].map(threadId => ({
    activityAt: threadId === "recent" ? now - 1 : 1, entryKind: "thread", title: threadId, identity: { harness: "codex", threadId },
    metadata: { archived: false, pinned: threadId === "pinned", snoozed: false },
    lifecycle: threadId === "missing-time"
      ? { kind: "stopped", reason: "userMarkedStopped", settled: true }
      : { kind: "completed", reason: "providerInactive", settled: true },
    settledAt: threadId === "missing-time" ? null : threadId === "recent" ? 1 : now,
  }));
  await persistence.writeProject("project", { drafts: [], records, version: 4 });
  const controller = new WorkbenchThreadStateController({
    storageRoot: "retroactive-archive", threadStateStore: persistence, now: () => now,
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [],
  });
  const read = async (id: string) => (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find(entry => entry.entryKind === "thread" && entry.identity.threadId === id);
  try {
    for (const id of ["overdue", "pinned", "recent", "missing-time"]) {
      const entry = await read(id);
      assert.ok(entry?.entryKind === "thread");
      assert.equal(entry.metadata.archived, id === "overdue" || id === "missing-time");
      assert.equal(entry.lifecycle.kind, id === "missing-time" ? "stopped" : "completed");
    }
    await controller.handleRequest("observer", {
      method: "workbench/thread-state/pin/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("pinned") }, pinned: false,
    });
    const unpinned = await read("pinned");
    assert.ok(unpinned?.entryKind === "thread");
    assert.equal(unpinned.metadata.archived, true);
    await controller.handleRequest("observer", {
      method: "workbench/thread-state/restore", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("overdue") },
    });
    const restored = await read("overdue");
    assert.ok(restored?.entryKind === "thread");
    assert.equal(restored.metadata.archived, false);
    assert.equal(restored.lifecycle.settled, false);
  } finally { await controller.dispose(); }
});

test("failed retroactive archival preserves the visible thread and its settled folder", async () => {
  const persistence = new MemoryThreadStatePersistence();
  const folderId = "b5bf699f-ea4b-45cf-9583-7449b536ea44";
  await persistence.writeProject("project", {
    version: 4, drafts: [],
    records: [{
      activityAt: 1, title: "Thread", entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("overdue") },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
      metadata: { archived: false, pinned: false, snoozed: false }, settledAt: 1,
    }],
    displayOrder: { folders: [{ folderId, section: "settled", title: "Keep", threadKeys: ["codex:overdue"] }] },
  });
  const write = persistence.writeChanges.bind(persistence);
  persistence.writeChanges = async (projectId, changes) => {
    if (changes.records?.some(record => record.entryKind === "thread" && record.metadata.archived)) {
      throw new Error("archive save failed");
    }
    await write(projectId, changes);
  };
  const controller = new WorkbenchThreadStateController({
    storageRoot: "archive-save-failure", threadStateStore: persistence, now: () => 20 * 24 * 60 * 60 * 1_000,
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [],
  });
  try {
    await assert.rejects(controller.getSnapshot(fixtureProjectIds["project"]), /archive save failed/u);
    const snapshot = await controller.getSnapshot(fixtureProjectIds["project"]);
    const entry = snapshot.entries[0];
    assert.ok(entry?.entryKind === "thread");
    assert.equal(entry.metadata.archived, false);
    assert.deepEqual(snapshot.displayOrder?.folders?.find(folder => folder.folderId === folderId)?.threadKeys, ["codex:overdue"]);
  } finally { await controller.dispose(); }
});

test("questionnaire snooze retains input through interruption, then stop dismisses and wakes it", async () => {
  const question = {
    itemId: "b5bf699f-ea4b-45cf-9583-7449b536ea44", requestKey: "request", turnId: null,
    request: { id: "request", title: "Choose", summary: "", submitLabel: "Submit", questions: [
      { id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false },
    ] },
  };
  const provider: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1, entryKind: "thread", title: "Task", identity: { harness: "codex", threadId: fixtureThreadIds["snooze-question"] },
    metadata: { archived: false, pinned: false, snoozed: false },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "request", turnId: fixtureTurnIds["turn"], settled: false },
    pendingQuestionnaire: question,
  };
  let interrupts = 0;
  const controller = new WorkbenchThreadStateController({
    storageRoot: "questionnaire-snooze", threadStateStore: new MemoryThreadStatePersistence(),
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_project, _signal, accept) => { await accept("codex", [provider], { complete: true }); return []; },
    interruptQuestionnaire: async () => {
      interrupts++;
      await controller.applyLifecycle(fixtureProjectIds["project"], "codex", provider.identity.threadId, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") });
      return true;
    },
  });
  try {
    await controller.readProject(fixtureProjectIds["project"]);
    await controller.refresh(fixtureProjectIds["project"]);
    const response = await controller.handleRequest("observer", {
      method: "workbench/thread-state/questionnaire/snooze", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: provider.identity, requestKey: question.requestKey,
    });
    assert.equal(response.error, undefined);
    assert.equal(interrupts, 1);
    const read = async () => (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find(entry => entry.entryKind === "thread" && entry.identity.threadId === provider.identity.threadId);
    let entry = await read();
    assert.ok(entry?.entryKind === "thread");
    assert.equal(entry.metadata.snoozed, true);
    assert.equal(entry.lifecycle.kind, "needsAttention");
    assert.deepEqual(entry.pendingQuestionnaire, question);
    await controller.applyLifecycle(fixtureProjectIds["project"], "codex", provider.identity.threadId, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") });
    entry = await read();
    assert.ok(entry?.entryKind === "thread");
    assert.equal(entry.lifecycle.kind, "needsAttention");
    await controller.handleRequest("observer", {
      method: "workbench/thread-state/questionnaire/dismiss", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: provider.identity, requestKey: question.requestKey,
    });
    entry = await read();
    assert.ok(entry?.entryKind === "thread");
    assert.equal(entry.lifecycle.kind, "stopped");
    assert.equal(entry.metadata.snoozed, false);
    assert.equal(entry.pendingQuestionnaire, null);
  } finally { await controller.dispose(); }
});

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
    identity: { harness: "codex" as const, threadId: WorkbenchThreadIdSchema.parse(threadId) },
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

test("independent project subscribers and warm reads do not own background reconciliation", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-state-");
  const root = temporary.path;
  const published: Array<{ connectionId: string; revision: number }> = [];
  let reconciliations = 0;
  const knownEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["known"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Known",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliations += 1;
      await acceptProviderSnapshot("codex", [knownEntry], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  const observe = (connectionId: string) => controller.subscribeProjects(projectId => {
    const snapshot = controller.peekProject(projectId);
    if (snapshot) published.push({ connectionId, revision: snapshot.revision });
  });
  const stopA = observe("a");
  const first = await controller.readProject(fixtureProjectIds["project"]);
  assert.equal(first.freshness, "loading");
  await waitFor(() => reconciliations === 1, "Initial reconciliation did not start.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const stopB = observe("b");
  const second = await controller.readProject(fixtureProjectIds["project"]);
  assert.equal(second.freshness, "fresh", second.error ?? "Reconciliation did not become fresh.");
  assert.equal(second.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "known"), true);
  assert.equal(reconciliations, 1);
  await controller.refresh(fixtureProjectIds["project"]);
  assert.equal(reconciliations, 2);
  assert.deepEqual(new Set(published.map((entry) => entry.connectionId)), new Set(["a", "b"]));
  for (const connectionId of ["a", "b"]) {
    const revisions = published.filter((entry) => entry.connectionId === connectionId).map((entry) => entry.revision);
    assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right));
    assert.equal(new Set(revisions).size, revisions.length);
  }
  stopA();
  const before = published.filter(item => item.connectionId === "a").length;
  await controller.refresh(fixtureProjectIds["project"]);
  assert.equal(published.filter(item => item.connectionId === "a").length, before);
  assert.ok(published.filter(item => item.connectionId === "b").length > 0);
  stopB();
  await controller.readProject(fixtureProjectIds["project"]);
  assert.equal(reconciliations, 2, "Removing and adding consumers must not restart the in-flight refresh.");
  await controller.dispose();
});

test("retained project folders import into the legacy pinned export with source-qualified members", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-global-pinned-layout-");
  const root = temporary.path;
  const folderId = fixtureIdentitySchemas.FolderIdSchema.parse("00000000-0000-4000-8000-000000000041");
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
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: projects.map((id) => projectOption(id, path.join(root, id))), rootPath: root }),
    reconcileProject: async () => [],
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project-a"]);
  await controller.readProject(fixtureProjectIds["project-b"]);
  const keyA = getProjectQualifiedThreadDisplayKey(fixtureProjectIds["project-a"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:a"));
  const stored = await readGlobalState<{ displayOrder: { folders?: Array<{ threadKeys: string[] }> } }>(root, "pinnedLayout");
  assert.deepEqual(stored.displayOrder.folders?.[0]?.threadKeys, [keyA]);
  await controller.dispose();
  await temporary.dispose();
});

test("a failed priority write restores the loaded project state", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-pinned-move-rollback-");
  const root = temporary.path;
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
    reconcileProject: async () => [],
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  const writeChanges = persistence.writeChanges.bind(persistence);
  persistence.writeChanges = async () => {
    persistence.writeChanges = writeChanges;
    throw new Error("Project persistence unavailable.");
  };

  await assert.rejects(
    controller.handleRequest("observer", {
      method: "workbench/thread-state/priority/set",
      projectId: fixtureProjectIds["project"],
      priority: "pinned",
      sourceKey: "codex:thread",
    }),
    /Project persistence unavailable/u,
  );
  const entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.metadata : null, { archived: false, pinned: false, snoozed: true });
  await controller.dispose();
  await temporary.dispose();
});

test("reconciled project thread state persists authoritatively in SQLite across controller restart", async () => {
  const projectId = testProjectIds.project;
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-sqlite-authority-");
  const root = temporary.path;
  await fs.mkdir(path.join(root, ".workbench"), { recursive: true });
  const database = new WorkbenchDatabaseController({ databasePath: path.join(root, ".workbench", "workbench.sqlite3") });
  const store = new WorkbenchThreadStateStore(database);
  const [alpha, beta] = await database.observeThreadIdentities(["alpha", "beta"].map(nativeThreadId => ({
    native: { harness: "codex" as const, nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId), nativeLocation: root },
    projectId, projectRoot: root, title: nativeThreadId, createdAt: 1, updatedAt: 1, activityAt: 1,
  })));
  const providerEntries: WorkbenchThreadSidebarEntry[] = [
    pinnedRecord(alpha!.threadId, "Private alpha title"),
    pinnedRecord(beta!.threadId, "Private beta title"),
  ];
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [{ ...projectOption("project", root), id: projectId }], rootPath: root }),
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
    threadStateStore: store,
  });
  let controller = createController();
  try {
    await controller.readProject(projectId);
    await waitFor(async () => (await controller.getSnapshot(projectId)).entries.length === 2, "Provider entries did not reconcile.");
    const projectDocument = await store.readProject(projectId) as { records?: unknown[] } | null;
    assert.equal(projectDocument?.records?.length, 2);

    await controller.dispose();
    controller = createController();
    const reopened = await controller.getSnapshot(projectId);
    assert.deepEqual(reopened.entries.map(entry => entry.title).sort(), ["Private alpha title", "Private beta title"]);
  } finally {
    await controller.dispose();
    await database.close();
    await temporary.dispose();
  }
});

test("authoritative SQLite read and write failures surface at the controller boundary", async () => {
  const readTemporary = await WorkbenchTemporaryDirectory.create("workbench-thread-sqlite-read-failure-");
  const readRoot = readTemporary.path;
  const readStore = new MemoryThreadStatePersistence();
  readStore.readProject = async () => { throw new Error("sqlite read unavailable"); };
  const readController = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [projectOption("project", readRoot)], rootPath: readRoot }),
    reconcileProject: async () => [],
    storageRoot: readRoot,
    threadStateStore: readStore,
  });
  try {
    await assert.rejects(readController.getSnapshot(fixtureProjectIds["project"]), /sqlite read unavailable/u);
  } finally {
    await readController.dispose();
    await readTemporary.dispose();
  }

  const writeTemporary = await WorkbenchTemporaryDirectory.create("workbench-thread-sqlite-write-failure-");
  const writeRoot = writeTemporary.path;
  const writeStore = new MemoryThreadStatePersistence();
  const writeController = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [projectOption("project", writeRoot)], rootPath: writeRoot }),
    reconcileProject: async () => [],
    storageRoot: writeRoot,
    threadStateStore: writeStore,
  });
  try {
    await writeController.readProject(fixtureProjectIds["project"]);
    writeStore.writeChanges = async () => { throw new Error("sqlite write unavailable"); };
    await assert.rejects(writeController.ensureProviderEntry(fixtureProjectIds["project"],
      pinnedRecord("thread", "Rejected write")), /sqlite write unavailable/u);
  } finally {
    await writeController.dispose();
    await writeTemporary.dispose();
  }
});

test("repairable global pinned layout drift cannot block thread-state open", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-global-pinned-layout-repair-");
  const root = temporary.path;
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
    reconcileProject: async () => [],
    storageRoot: root,
  });

  await controller.readProject(fixtureProjectIds["project"]);
  const stored = await readGlobalState<{ revision: number }>(root, "pinnedLayout");
  assert.equal(stored.revision, 0);
  assert.match(logs.join("\n"), /Conformed stored pinned thread layout/u);
  assert.match(logs.join("\n"), /revision/u);
  assert.doesNotMatch(logs.join("\n"), /must-not-be-logged/u);
  await controller.dispose();
  await temporary.dispose();
});

test("project subscribers receive activity and transient wait state without socket-owned observations", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const root = "workspace-activity-and-wait";
  let now = 10;
  const entry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["waiting-thread"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Waiting thread",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => now,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [entry], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  context.after(() => controller.dispose());
  await controller.refresh(fixtureProjectIds.project);
  const received: WorkbenchThreadSidebarSnapshot[] = [];
  let otherUpdates = 0;
  const stop = controller.subscribeProjects(projectId => received.push(controller.peekProject(projectId)!));
  controller.subscribeProjects(() => otherUpdates++);
  now = 20;
  await controller.observeActivity("codex", entry.identity.threadId, undefined, fixtureProjectIds.project);
  assert.equal(received.at(-1)?.entries[0]?.activityAt, now);
  controller.setThreadWaitState("codex", "waiting-thread", ["subagent_wait"]);
  const waiting = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread");
  assert.equal(waiting?.entryKind === "thread" ? waiting.waitingFor : null, "subagents");
  await controller.observeDisplayLabel("codex", fixtureThreadIds["waiting-thread"], "Still waiting");
  const stored = await readProjectState<{ records: Array<{ waitingFor?: string }> }>(root, "project");
  assert.equal(stored.records[0]?.waitingFor, undefined);
  stop();
  const releasedCount = received.length;
  const liveCount = otherUpdates;
  controller.setThreadWaitState("codex", "waiting-thread", []);
  const cleared = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread");
  assert.equal(cleared?.entryKind === "thread" ? cleared.waitingFor : null, undefined);
  assert.equal(received.length, releasedCount);
  assert.ok(otherUpdates > liveCount);
});

test("an observed project represents a missing thread as an empty observation", async () => {
  const controller = new WorkbenchThreadStateController({
    storageRoot: "missing-thread-observation",
    threadStateStore: new MemoryThreadStatePersistence(),
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/alpha")],
      rootPath: "C:/",
    }),
    reconcileProject: async () => [],
  });
  try {
    await controller.readProject(fixtureProjectIds["alpha"]);
    const expectedFreshness = (await controller.getSnapshot(fixtureProjectIds["alpha"])).freshness;
    const observation = await controller.readWorkspaceThread({
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
      subscriptionId: "709113f5-ca7c-4ba0-b26b-10bd31af8648",
      target: {
        harness: "codex",
        kind: "provider",
        threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("missing-thread"),
      },
    });
    assert.deepEqual(observation.entries, []);
    assert.equal(observation.freshness, expectedFreshness);
  } finally {
    await controller.dispose();
  }
});

test("a subagent observation includes its root without granting authority through socket selection", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-pinned-context-");
  const root = temporary.path;
  const pinnedRoot: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 3,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["root-thread"] },
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
    identity: { harness: "opencode", threadId: fixtureThreadIds["child-thread"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    name: "Child",
    parentThreadId: fixtureThreadIds["root-thread"],
    pinned: false,
    profileId: "default",
    profileName: "Default",
    projectId: fixtureProjectIds["owner"],
    title: "Child",
    updatedAt: 2,
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("viewed", path.join(root, "viewed")), projectOption("owner", path.join(root, "owner"))],
      rootPath: root,
    }),
    renameThread: async (_projectId, _harness, _threadId, title) => title,
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      if (projectId === "owner") {
        await acceptProviderSnapshot("codex", [pinnedRoot], { complete: true });
        await acceptProviderSnapshot("opencode", [directSubagent], { complete: true });
      }
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["owner"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["owner"])).entries.length === 2, "Pinned owner did not load.");
  const observed = await controller.readWorkspaceThread({
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    subscriptionId: "8a1f2219-334a-48ce-a016-bd3c595402ee",
    target: { harness: "opencode", kind: "subagent", parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child-thread") },
  });
  assert.deepEqual(observed.entries.map(entry =>
    entry.entryKind === "draft" ? entry.draft.draftId : entry.identity.threadId), ["root-thread", "child-thread"]);

  const renamed = await controller.handleRequest("viewer", {
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread") },
    method: "workbench/thread-state/title/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    title: "Renamed while open",
  });
  assert.equal(WorkbenchThreadTitleMutationResultSchema.parse(renamed.result).title, "Renamed while open");

  await controller.handleRequest("owner-loader", {
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread") },
    method: "workbench/thread-state/snooze/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    snoozed: true,
  });
  const snoozed = await controller.readWorkspaceThread({
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    subscriptionId: "bb7efb3d-4670-4198-a8ab-8926782c4ed3",
    target: { kind: "provider", harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread") },
  });
  assert.ok(snoozed.entries.some(entry => entry.entryKind === "thread" && entry.metadata.snoozed));
  const foreign = await controller.handleRequest("viewer", {
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread") },
    method: "workbench/thread-state/title/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("viewed"),
    title: "Must not rename",
  });
  assert.equal(foreign.error?.code, "invalidThreadOwner");
  await controller.dispose();
  await temporary.dispose();
});

test("provider omission retains saved threads through partial, complete, and reopened snapshots", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-progressive-");
  const root = temporary.path;
  const oldEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["old"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Old",
  };
  const newEntry = { ...oldEntry, activityAt: 2, identity: { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("new") }, title: "New" };
  const initialInstalled = Promise.withResolvers<void>();
  const incompleteInstalled = Promise.withResolvers<void>();
  const completeInstalled = Promise.withResolvers<void>();
  const finalGate = Promise.withResolvers<void>();
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [oldEntry], { complete: true });
      initialInstalled.resolve();
      return [];
    },
    storageRoot: root,
  });
  try {
    await controller.readProject(fixtureProjectIds["project"]);
    await initialInstalled.promise;
    await controller.dispose();
    const refreshing = new WorkbenchThreadStateController({
      getProjectCatalog: projectCatalog,
      reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
        await acceptProviderSnapshot("codex", [newEntry], { complete: false });
        incompleteInstalled.resolve();
        await finalGate.promise;
        await acceptProviderSnapshot("codex", [newEntry], { complete: true });
        completeInstalled.resolve();
        return [];
      },
      storageRoot: root,
    });
    try {
      await refreshing.readProject(fixtureProjectIds["project"]);
      await incompleteInstalled.promise;
      const incomplete = await refreshing.getSnapshot(fixtureProjectIds["project"]);
      assert.deepEqual(incomplete.entries.filter((entry) => entry.entryKind !== "draft").map((entry) => entry.identity.threadId).sort(), ["new", "old"]);
      finalGate.resolve();
      await completeInstalled.promise;
      const complete = await refreshing.getSnapshot(fixtureProjectIds["project"]);
      assert.deepEqual(complete.entries.filter((entry) => entry.entryKind !== "draft").map((entry) => entry.identity.threadId).sort(), ["new", "old"]);
    } finally {
      finalGate.resolve();
      await refreshing.dispose();
    }
    const reopened = new WorkbenchThreadStateController({
      getProjectCatalog: projectCatalog,
      reconcileProject: async () => [], storageRoot: root,
    });
    try {
      const snapshot = await reopened.getSnapshot(fixtureProjectIds["project"]);
      assert.deepEqual(snapshot.entries.filter((entry) => entry.entryKind !== "draft").map((entry) => entry.identity.threadId).sort(), ["new", "old"]);
    } finally {
      await reopened.dispose();
    }
  } finally {
    finalGate.resolve();
    await controller.dispose();
    await temporary.dispose();
  }
});

test("concurrent first reads share one project initialization and reconciliation", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-concurrent-open-");
  const root = temporary.path;
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
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => { reconciliations += 1; return []; },
    storageRoot: root,
  });
  const firstOpen = controller.readProject(fixtureProjectIds["project"]);
  const secondOpen = controller.readProject(fixtureProjectIds["project"]);
  await waitFor(() => projectLoads === 1, "Shared project initialization did not read persisted state.");
  assert.equal(projectLoads, 1);
  releaseRead();
  await Promise.all([firstOpen, secondOpen]);
  assert.equal(projectLoads, 1);
  await waitFor(() => reconciliations === 1, "Shared reconciliation did not start.");
  assert.equal(reconciliations, 1);
  await controller.dispose();
  await temporary.dispose();
});

test("missing SQLite project state initializes empty and the first mutation persists", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-sqlite-empty-");
  const storageRoot = temporary.path;
  const persistence = testPersistence(storageRoot);
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: [projectOption("project", storageRoot)], rootPath: storageRoot }),
    reconcileProject: async () => [],
    storageRoot,
  });

  assert.equal(await persistence.readProject("project"), null);
  const opened = await controller.readProject(fixtureProjectIds["project"]);
  assert.deepEqual(opened.entries, []);
  assert.deepEqual(await persistence.readProject("project"), {
    drafts: [],
    newThreadProfile: null,
    records: [],
    version: 4,
  });
  await controller.ensureProviderEntry(fixtureProjectIds.project, pinnedRecord("thread", "Persisted thread"));
  const stored = await persistence.readProject("project") as { records: Array<{ identity: { threadId: string } }> };
  assert.deepEqual(stored.records.map(record => record.identity.threadId), ["thread"]);
  await controller.dispose();
  await temporary.dispose();
});

test("stored state repairs invalid leaves without erasing thread or draft siblings", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-conformance-");
  const root = temporary.path;
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
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("kept-thread") },
    lifecycle: { agent: { agentStatus: "working" }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    providerObserved: true,
    title: "Kept title",
  };
  const draft = {
    agent: null,
    attachments: [{ id: "kept", url: "data:text/plain,kept" }, { id: "also-kept", url: "data:text/plain,also-kept" }],
    clientUpdatedAt: 2,
    composerSettings: {},
    createdAt: 1,
    draftId: fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000099"),
    harness: "codex",
    model: null,
    pinned: true,
    profileId: null,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("old-project"),
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
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliations += 1;
      await acceptProviderSnapshot("codex", [{
        activityAt: 11,
        entryKind: "thread",
        identity: { harness: "codex", threadId: fixtureThreadIds["kept-thread"] },
        lifecycle: { agent: { agentStatus: "working" }, kind: "working", reason: "acceptedIntent", settled: false },
        metadata: { archived: false, pinned: false, snoozed: false },
        title: "Provider title",
      }], { complete: true });
      return [];
    },
    storageRoot: root,
  });

  const opened = await controller.readProject(fixtureProjectIds["project"]);
  const openedThread = opened.entries.find((entry) => entry.entryKind === "thread");
  const openedDraft = opened.entries.find((entry) => entry.entryKind === "draft");
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
    attachments: [{ id: "kept", url: "data:text/plain,kept" }, { id: "also-kept", url: "data:text/plain,also-kept" }],
    metadata: { archived: false, pinned: true, snoozed: false },
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    prompt: "Kept draft",
  });
  await waitFor(() => reconciliations === 1, "Reconciliation did not start after conformant state installation.");
  const reconciled = await controller.getSnapshot(fixtureProjectIds["project"]);
  const reconciledThread = reconciled.entries.find((entry) => entry.entryKind === "thread");
  assert.equal(reconciledThread?.entryKind === "thread" ? reconciledThread.lifecycle.kind : null, "working");
  assert.equal(logs.some((message) => message.includes("repairedPaths=gitArc")), true);
  assert.equal(logs.some((message) => message.includes("projectId")), true);
  await controller.dispose();
  await temporary.dispose();
});

test("legacy presentation export pages drafts and reads inline attachments without copying full data URLs", async context => {
  const persistence = new MemoryThreadStatePersistence();
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [], storageRoot: "presentation-export", threadStateStore: persistence,
  });
  context.after(() => controller.dispose());
  const projectId = fixtureProjectIds.project;
  const firstId = fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111");
  const secondId = fixtureIdentitySchemas.DraftIdSchema.parse("22222222-2222-4222-8222-222222222222");
  const image = Buffer.from("legacy-image");
  const draft = {
    projectId, profileId: null, composerSettings: EMPTY_CODEX_SETTINGS,
    prompt: "preserve", attachments: [{ id: "image-1", url: `data:image/png;base64,${image.toString("base64")}` }],
    clientUpdatedAt: 1, createdAt: 1, updatedAt: 1,
  };
  persistence.projects.set(projectId, { version: 4, records: [],
    drafts: [firstId, secondId].map(draftId => ({ ...draft, draftId })) });
  const first = await controller.exportPresentationPage({ projectId, limit: 1 });
  assert.equal(first.drafts.length, 1);
  assert.equal(first.drafts[0]?.attachments[0]?.kind, "inline");
  const chunk = await controller.readPresentationAttachmentChunk({
    projectId, draftId: firstId, attachmentId: "image-1", offset: 0,
  });
  assert.deepEqual(Buffer.from(chunk.bytes, "base64"), image);
  assert.equal(chunk.nextOffset, null);
  const second = await controller.exportPresentationPage({ projectId, cursor: first.nextCursor, limit: 1 });
  assert.equal(second.drafts[0]?.draftId, secondId);
  assert.equal(second.nextCursor, null);
  const selected = await controller.exportPresentationPage({ projectId, draftIds: [secondId] });
  assert.deepEqual(selected.drafts.map(item => item.draftId), [secondId],
    "missing-source transfer must not reread an already receipted draft");
  const layout = await controller.exportPresentationLayoutChunk({
    scope: "project", projectId, sourceRevision: null, offset: 0,
  });
  assert.equal(JSON.parse(Buffer.from(layout.bytes, "base64").toString("utf8")).displayOrder !== undefined, true);
  assert.equal(layout.nextOffset, null);
  await controller.ensureProviderEntry(projectId, pinnedRecord("thread", "export-revision"));
  await controller.setTitle(projectId, "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"), "changed revision");
  await assert.rejects(controller.exportPresentationPage({ projectId, cursor: first.nextCursor, limit: 1 }),
    /source changed/u);
  await assert.rejects(controller.exportPresentationLayoutChunk({
    scope: "project", projectId, sourceRevision: layout.sourceRevision, offset: 0,
  }), /source changed/u);
});

test("presentation manifest identifies missing sources without exporting every empty project", async context => {
  const projectId = fixtureProjectIds.alpha;
  const emptyProjectId = fixtureProjectIds.beta;
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111");
  const persistence = new MemoryThreadStatePersistence();
  persistence.projects.set(projectId, { version: 4, records: [], drafts: [{
    draftId, projectId, profileId: null, composerSettings: EMPTY_CODEX_SETTINGS,
    prompt: "keep", attachments: [], clientUpdatedAt: 1, createdAt: 1, updatedAt: 1,
  }] });
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption(projectId, "C:/alpha"), projectOption(emptyProjectId, "C:/beta")],
      rootPath: "C:/",
    }),
    reconcileProject: async () => [], storageRoot: "presentation-manifest",
    threadStateStore: persistence,
  });
  context.after(() => controller.dispose());
  const manifest = await controller.exportPresentationManifestPage({ limit: 100 });
  assert.deepEqual(manifest.sources, [
    { kind: "draft", projectId, sourceId: draftId },
  ]);
  assert.equal(manifest.nextCursor, null);
});

test("legacy layout export keeps each socket response bounded across a large retained order", async context => {
  const persistence = new MemoryThreadStatePersistence();
  const projectId = fixtureProjectIds.project;
  persistence.projects.set(projectId, {
    version: 4, records: [], drafts: [],
    displayOrder: { pinned: Object.fromEntries(Array.from({ length: 2_500 }, (_, index) =>
      [`codex:thread-${index}`, { above: [], below: [] }])) },
  });
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [], storageRoot: "presentation-large-layout", threadStateStore: persistence,
  });
  context.after(() => controller.dispose());
  const chunks: Buffer[] = [];
  let revision: number | null = null;
  let offset = 0;
  for (;;) {
    const result = await controller.exportPresentationLayoutChunk({
      scope: "project", projectId, sourceRevision: revision, offset,
    });
    revision = result.sourceRevision;
    const bytes = Buffer.from(result.bytes, "base64");
    assert.ok(bytes.length <= 64 * 1024);
    chunks.push(bytes);
    if (result.nextOffset === null) {
      assert.equal(Buffer.concat(chunks).length, result.totalBytes);
      break;
    }
    offset = result.nextOffset;
  }
  assert.ok(chunks.length > 1);
  const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(Object.keys(decoded.displayOrder.pinned).length, 2_500);
});

test("draft targets are provider-agnostic and adopt any addressed provider", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-draft-provider-");
  const root = temporary.path;
  const projectId = fixtureProjectIds.project;
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111");
  const settings = { harness: "codex" as const, model: "codex-model", agentPath: null, agentSource: null, reasoningEffort: null, serviceTier: null };
  const selection = { kind: "custom" as const, settings };
  await seedProjectState(root, "project", {
    drafts: [{ draftId, projectId, profileId: null, composerSettings: settings, prompt: "Keep this", attachments: [], clientUpdatedAt: 1, createdAt: 1, updatedAt: 1 }],
    records: [], version: 3, newThreadProfile: selection,
  });
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [], storageRoot: root,
    readComposerProfiles: async () => ({ profiles: [{ id: "named", name: "Named", scope: { kind: "global" }, createdAt: 1, updatedAt: 1, agentPath: null, agentSource: null, harness: "opencode", model: "opencode-model", reasoningEffort: null, serviceTier: null }] }),
  });
  try {
    const oldSlot = { kind: "draft" as const, projectId, draftId, harness: "codex" as const };
    const next = { kind: "custom" as const, settings: { ...settings, harness: "copilot" as const, model: "copilot-model" } };
    assert.equal(await controller.setComposerProfileTarget(oldSlot, next), true);
    // The draft target reads back the same provider no matter which harness addresses it.
    assert.deepEqual(await controller.readComposerProfileTarget(oldSlot), next);
    assert.deepEqual(await controller.readComposerProfileTarget({ ...oldSlot, harness: "copilot" }), next);
    assert.deepEqual(await controller.readComposerProfileTarget({ ...oldSlot, harness: "opencode" }), next);
    const profileSelection = { kind: "profile" as const, profileId: "named", settings: { ...settings, harness: "opencode" as const, model: "opencode-model" } };
    assert.equal(await controller.setComposerProfileTarget({ ...oldSlot, harness: "copilot" }, profileSelection), true);
    assert.deepEqual(await controller.readComposerProfileTarget(oldSlot), profileSelection);
    assert.deepEqual(await controller.readComposerProfileTarget({ ...oldSlot, harness: "opencode" }), profileSelection);
    assert.deepEqual(await controller.readComposerProfileTarget({ kind: "new-thread", projectId }), profileSelection);
    const awaitingModels = { kind: "custom" as const, settings: { ...settings, harness: "opencode" as const, model: "" } };
    assert.equal(await controller.setComposerProfileTarget(oldSlot, awaitingModels), true);
    assert.deepEqual(await controller.readComposerProfileTarget(oldSlot), awaitingModels);
    assert.deepEqual(await controller.readComposerProfileTarget({ kind: "new-thread", projectId }), awaitingModels);
    await assert.rejects(controller.prepareComposerProfileTarget({ kind: "new-thread", projectId }), /model/u);
    const entry = (await controller.getSnapshot(projectId)).entries.find(entry => entry.entryKind === "draft");
    assert.equal(entry?.entryKind === "draft" ? entry.draft.prompt : null, "Keep this");
  } finally {
    await controller.dispose();
    await temporary.dispose();
  }
});

test("legacy profiles migrate and accepted provider work retains its configured profile", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-profiles-");
  const root = temporary.path;
  const profiles: WorkbenchComposerProfile[] = [];
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111");
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
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
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
    reconcileProject: async () => [],
    readComposerProfiles: async () => ({ profiles }),
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);

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
  profiles.push({ ...migrated.settings, id: migrated.profileId, name: "Legacy", scope: { kind: "project", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") }, createdAt: 1, updatedAt: 1 });
  assert.deepEqual(await controller.readComposerProfileTarget({ kind: "new-thread", projectId: fixtureProjectIds["project"] }), migrated);
  assert.deepEqual(await controller.readComposerProfileTarget({ draftId, harness: "codex", kind: "draft", projectId: fixtureProjectIds["project"] }), migrated);

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
  profiles.push({ ...selected.settings, id: selected.profileId, name: "Current", scope: { kind: "project", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") }, createdAt: 1, updatedAt: 1 });
  assert.equal(
    await controller.setComposerProfileTarget({ draftId, harness: "codex", kind: "draft", projectId: fixtureProjectIds["project"] }, selected),
    true,
  );
  assert.deepEqual(await controller.readComposerProfileTarget({ kind: "new-thread", projectId: fixtureProjectIds["project"] }), selected);

  const providerEntry: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> = {
    activityAt: 3,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["materialized"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Provider title",
  };
  await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry);
  const threadSlot = { harness: "codex" as const, kind: "thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("materialized") };
  await controller.setComposerProfileTarget(threadSlot, selected);
  assert.equal(await controller.setComposerProfileTarget(threadSlot, {
    kind: "custom", settings: { ...selected.settings, model: "" },
  }), false);
  await controller.acceptProviderIntent(fixtureProjectIds["project"], "codex", fixtureThreadIds["materialized"], fixtureTurnIds["turn"]);
  assert.deepEqual(await controller.readComposerProfileTarget(threadSlot), selected);

  const stored = await readProjectState<{
    drafts: unknown[];
    newThreadProfile: WorkbenchComposerProfileTargetSelection;
    records: Array<{ identity: { threadId: string }; profile: WorkbenchComposerProfileTargetSelection | null }>;
    version: number;
  }>(root, "project");
  assert.equal(stored.version, 4);
  assert.equal(stored.drafts.length, 1, "Provider acceptance does not consume legacy import data.");
  assert.deepEqual(stored.newThreadProfile, selected);
  assert.deepEqual(stored.records.find((record) => record.identity.threadId === "materialized")?.profile, selected);
  await controller.setComposerProfileTarget({ kind: "new-thread", projectId: fixtureProjectIds["project"] }, migrated);
  await controller.acceptProviderIntent(fixtureProjectIds["project"], "codex", fixtureThreadIds["materialized"], fixtureTurnIds["next-turn"]);
  assert.deepEqual(await controller.readComposerProfileTarget(threadSlot), selected);
  await controller.dispose();
  await temporary.dispose();
});

test("an unidentified stored record cannot reconcile or overwrite its source file", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-unidentified-");
  const root = temporary.path;
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
    reconcileProject: async () => { reconciliations += 1; return []; },
    storageRoot: root,
  });

  await assert.rejects(controller.readProject(fixtureProjectIds["project"]), /without a recoverable identity/u);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reconciliations, 0);
  assert.deepEqual(await readProjectState(root, "project"), source);
  await controller.dispose();
  await temporary.dispose();
});

test("headless provider refresh preserves Git lifecycle and MCP generation without leaking internal fields", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-headless-mcp-");
  const root = temporary.path;
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
    reconcileProject: async () => [],
    resolveGitArc: async () => gitArc,
    resolveGitArcPlan: async () => gitArcPlan,
    storageRoot: root,
  });
  const providerEntry: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["headless"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Headless thread",
  };

  const controller = createController();
  await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry);
  await controller.setMcpGeneration(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("headless"), "epoch:2");
  await controller.refreshGitArcState(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("headless"));
  await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry);
  assert.equal(await controller.getMcpGeneration(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("headless")), "epoch:2");
  const projected = await controller.getSnapshot(fixtureProjectIds["project"]);
  const projectedEntry = projected.entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "headless");
  assert.deepEqual(projectedEntry?.entryKind === "thread" ? { gitArc: projectedEntry.gitArc, gitArcPlan: projectedEntry.gitArcPlan } : null, { gitArc, gitArcPlan });
  assert.equal(projected.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "headless"), true);
  assert.equal(JSON.stringify(projected).includes("mcpGeneration"), false);
  assert.equal(JSON.stringify(projected).includes("providerObserved"), false);
  await controller.dispose();

  const reopened = createController();
  assert.equal(await reopened.getMcpGeneration(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("headless")), "epoch:2");
  const reopenedEntry = (await reopened.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "headless");
  assert.deepEqual(reopenedEntry?.entryKind === "thread" ? { gitArc: reopenedEntry.gitArc, gitArcPlan: reopenedEntry.gitArcPlan } : null, { gitArc, gitArcPlan });
  await reopened.dispose();
  await temporary.dispose();
});

test("legacy settled thread metadata receives a fresh persisted retention grace window", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-v2-mcp-");
  const root = temporary.path;
  await seedProjectState(root, "project", {
    drafts: [],
    threads: [{
      archived: false,
      harness: "codex",
      lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
      mcpGeneration: "legacy:4",
      pinned: false,
      snoozed: false,
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("legacy-thread"),
      titleFallback: "Legacy thread",
    }],
    version: 2,
  });
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => 1_234,
    reconcileProject: async () => [],
    storageRoot: root,
  });

  assert.equal(await controller.getMcpGeneration(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("legacy-thread")), "legacy:4");
  assert.equal((await controller.getSnapshot(fixtureProjectIds["project"])).entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "legacy-thread"), true);
  const migrated = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; mcpGeneration?: string | null; settledAt?: number | null }>; version?: number }>(root, "project");
  assert.equal(migrated.version, 4);
  assert.deepEqual(migrated.records.map(({ gitHistoryCleanedAt, mcpGeneration, settledAt }) => ({ gitHistoryCleanedAt, mcpGeneration, settledAt })), [{ gitHistoryCleanedAt: null, mcpGeneration: "legacy:4", settledAt: 1_234 }]);
  await controller.ensureProviderEntry(fixtureProjectIds["project"], {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("legacy-thread") },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Legacy thread",
  });
  const stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; mcpGeneration?: string | null; providerObserved?: boolean; settledAt?: number | null }>; version?: number }>(root, "project");
  assert.equal(stored.version, 4);
  assert.deepEqual(stored.records.map(({ gitHistoryCleanedAt, mcpGeneration, providerObserved, settledAt }) => ({ gitHistoryCleanedAt, mcpGeneration, providerObserved, settledAt })), [{ gitHistoryCleanedAt: null, mcpGeneration: "legacy:4", providerObserved: true, settledAt: 1_234 }]);
  await controller.dispose();
  await temporary.dispose();
});

test("continuous settlement prunes once per durable epoch, retries failures, and resets on restore", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-git-retention-");
  const root = temporary.path;
  let now = 1_000;
  const pruned: Array<Array<{ harness: string; threadId: string }>> = [];
  let rejectNextPrune = false;
  let deferNextPrune = false;
  const providerEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["retained"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Retained thread",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => now,
    pruneExpiredGitState: async (_projectId, identities) => {
      if (deferNextPrune) {
        deferNextPrune = false;
        return identities;
      }
      if (rejectNextPrune) {
        rejectNextPrune = false;
        throw new Error("Retention cleanup failed.");
      }
      pruned.push(identities);
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [providerEntry], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).freshness === "fresh", "Initial reconciliation did not finish.");
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  let stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; settledAt?: number | null }> }>(root, "project");
  assert.equal(stored.records[0]?.settledAt, 1_000);
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, null);

  now += 13 * 24 * 60 * 60 * 1_000;
  await controller.refresh(fixtureProjectIds["project"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pruned.length, 0);
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/restore", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  stored = await readProjectState<{ records: Array<{ settledAt?: number | null }> }>(root, "project");
  assert.equal(stored.records[0]?.settledAt, null);

  now += 20 * 24 * 60 * 60 * 1_000;
  await controller.refresh(fixtureProjectIds["project"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(pruned.length, 0);
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  now += 14 * 24 * 60 * 60 * 1_000 + 1;
  deferNextPrune = true;
  await controller.refresh(fixtureProjectIds["project"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).freshness === "fresh", "Deferred retention did not reconcile.");
  stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null }> }>(root, "project");
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, null);
  assert.equal((await controller.getSnapshot(fixtureProjectIds["project"])).error, null);
  await controller.refresh(fixtureProjectIds["project"]);
  await waitFor(() => pruned.length === 1, "Expired settlement did not trigger Git retention cleanup.");
  assert.deepEqual(pruned[0], [providerEntry.identity]);
  await waitFor(async () => {
    const persisted = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null }> }>(root, "project");
    return persisted.records[0]?.gitHistoryCleanedAt === now;
  }, "Successful retention cleanup was not persisted.");
  stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; settledAt?: number | null }> }>(root, "project");
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, now);
  await controller.refresh(fixtureProjectIds["project"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).freshness === "fresh", "Repeated reconciliation did not finish.");
  assert.equal(pruned.length, 1);

  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/restore", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null; settledAt?: number | null }> }>(root, "project");
  assert.deepEqual(stored.records.map(({ gitHistoryCleanedAt, settledAt }) => ({ gitHistoryCleanedAt, settledAt })), [{ gitHistoryCleanedAt: null, settledAt: null }]);
  await controller.handleRequest("observer", {
    identity: providerEntry.identity, method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  now += 14 * 24 * 60 * 60 * 1_000 + 1;
  rejectNextPrune = true;
  await controller.refresh(fixtureProjectIds["project"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).error?.includes("git-retention: Retention cleanup failed.") === true, "Failed retention cleanup did not surface.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null }> }>(root, "project");
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, null);
  await controller.refresh(fixtureProjectIds["project"]);
  await waitFor(() => pruned.length === 2, "Failed retention cleanup was not retried.");
  await waitFor(async () => {
    const persisted = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null }> }>(root, "project");
    return persisted.records[0]?.gitHistoryCleanedAt === now;
  }, "Retried retention cleanup was not persisted.");
  stored = await readProjectState<{ records: Array<{ gitHistoryCleanedAt?: number | null }> }>(root, "project");
  assert.equal(stored.records[0]?.gitHistoryCleanedAt, now);
  await controller.dispose();
  await temporary.dispose();
});

test("constructing and disposing does not enumerate projects or start migration", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-no-startup-migration-");
  const root = temporary.path;
  let catalogReads = 0;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => { catalogReads += 1; throw new Error("catalog unavailable"); },
    reconcileProject: async () => [],
    storageRoot: root,
  });
  assert.equal(catalogReads, 0);
  await controller.dispose();
  assert.equal(catalogReads, 0);
  await temporary.dispose();
});

test("disposal fences late reconciliation without awaiting its provider request", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-dispose-reconcile-");
  const root = temporary.path;
  const publications: WorkbenchThreadSidebarSnapshot[] = [];
  let reconciliationStarted = false;
  let releaseReconciliation = () => undefined;
  const reconciliationGate = new Promise<void>((resolve) => { releaseReconciliation = resolve; });
  const lateEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["late"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Late",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    onProject: snapshot => { publications.push(snapshot); },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliationStarted = true;
      await reconciliationGate;
      await acceptProviderSnapshot("codex", [lateEntry], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  await waitFor(() => reconciliationStarted, "Reconciliation did not start.");
  let disposed = false;
  await controller.dispose().then(() => { disposed = true; });
  assert.equal(disposed, true);
  publications.length = 0;
  releaseReconciliation();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(publications, []);
  await temporary.dispose();
});

test("background reconciliation survives UI disconnect and a warm reopen", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-warm-reopen-");
  const root = temporary.path;
  let reconciliationCount = 0;
  let staleAccept: ((harness: "codex", entries: WorkbenchThreadSidebarEntry[], options: { complete: boolean }) => void) | null = null;
  let releaseStale = () => undefined;
  const known = {
    activityAt: 1,
    entryKind: "thread" as const,
    identity: { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("known") },
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: true },
    metadata: { archived: false as const, pinned: false, snoozed: false },
    title: "Known",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliationCount += 1;
      if (reconciliationCount === 1) {
        await acceptProviderSnapshot("codex", [known], { complete: true });
        return [];
      }
      staleAccept = acceptProviderSnapshot as typeof staleAccept;
      return await new Promise((resolve) => { releaseStale = () => resolve([]); });
    },
    storageRoot: root,
  });
  const stop = controller.subscribeProjects(() => {});
  await controller.readProject(fixtureProjectIds["project"]);
  await waitFor(() => reconciliationCount === 1, "Initial reconciliation did not start.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await controller.getSnapshot(fixtureProjectIds["project"])).freshness, "fresh");

  await controller.refresh(fixtureProjectIds["project"]);
  assert.equal(reconciliationCount, 2);
  assert.equal((await controller.getSnapshot(fixtureProjectIds["project"])).freshness, "fresh");
  stop();
  const reopened = await controller.readProject(fixtureProjectIds["project"]);
  assert.equal(reopened.freshness, "fresh");
  assert.equal(reopened.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "known"), true);
  assert.equal(reconciliationCount, 2);

  staleAccept?.("codex", [{ ...known, identity: { harness: "codex", threadId: fixtureThreadIds["stale"] }, title: "Stale" }], { complete: true });
  releaseStale();
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "stale"), "Headless reconciliation did not publish after the UI reconnected.");
  await controller.dispose();
});

test("request telemetry reports bounded validation evidence without logging request values", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-telemetry-");
  const root = temporary.path;
  const logs: string[] = [];
  let now = 10;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    log: (message) => logs.push(message),
    now: () => now++,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [], { complete: true });
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

test("invalid title intent telemetry identifies strict-contract drift without logging field values", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-invalid-intent-");
  const root = temporary.path;
  const logs: string[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    log: (message) => logs.push(message),
    reconcileProject: async () => [],
    storageRoot: root,
  });
  const response = await controller.handleRequest("observer", {
    correlationHandle: "secret-correlation-value",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("secret-thread-id") },
    method: "workbench/thread-state/title/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("secret-project-id"),
    title: "secret title contents",
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("secret-turn-id"),
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

test("accepted intent survives provider discovery lag and remains visible after its lifecycle advances", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-accepted-");
  const root = temporary.path;
  const published: WorkbenchThreadSidebarEntry[] = [];
  const publishedSnapshots: WorkbenchThreadSidebarSnapshot[] = [];
  let now = 42;
  let providerEntries: WorkbenchThreadSidebarEntry[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => now,
    onProject: snapshot => {
      publishedSnapshots.push(snapshot);
      if (!("entries" in snapshot)) return;
      const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
      if (entry) published.push(entry);
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  publishedSnapshots.length = 0;
  await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.provider,
    fixtureTurnIds.turn, "First user message");
  const entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
  assert.ok(entry && entry.entryKind !== "draft");
  assert.equal(entry?.title, "First user message");
  assert.equal(entry.lifecycle.kind, "working");
  assert.deepEqual(entry.entryKind === "thread" ? entry.metadata : null, { archived: false, pinned: false, snoozed: false });
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
  await controller.observeActivity("codex", fixtureThreadIds["provider"]);
  let observed = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "provider");
  assert.equal(observed?.activityAt, 50);
  assert.equal(observed?.entryKind === "thread" ? observed.orderAt : null, 42);
  assert.equal("orderAt" in publishedSnapshots.at(-1)!, false);
  now = 60;
  await controller.observeActivity("codex", fixtureThreadIds["provider"], 55);
  observed = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "provider");
  assert.equal(observed?.activityAt, 60);
  assert.equal(observed?.entryKind === "thread" ? observed.orderAt : null, 55);
  const turnStartUpdate = publishedSnapshots.at(-1)?.entries.find(candidate => candidate.entryKind === "thread"
    && candidate.identity.threadId === "provider");
  assert.equal(turnStartUpdate?.entryKind === "thread" ? turnStartUpdate.orderAt : null, 55);
  now = 70;
  await controller.observeActivity("codex", fixtureThreadIds["provider"]);
  observed = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "provider");
  assert.equal(observed?.entryKind === "thread" ? observed.orderAt : null, 55);
  const stored = await readProjectState<{ drafts: unknown[]; records: Array<{ identity: { threadId: string }; orderAt?: number }> }>(root, "project");
  assert.deepEqual(stored.drafts, []);
  assert.equal(stored.records.some((candidate) => candidate.identity.threadId === "provider"), true);
  assert.equal(stored.records.find((candidate) => candidate.identity.threadId === "provider")?.orderAt, 55);
  providerEntries = [{
    activityAt: 999,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["provider"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: false, snoozed: false },
    orderAt: 999,
    title: "New thread",
  }];
  await controller.refresh(fixtureProjectIds["project"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const laggingEntry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
  assert.equal(laggingEntry?.activityAt, 70);
  assert.equal(laggingEntry?.title, "First user message");
  assert.equal(laggingEntry?.entryKind === "thread" ? laggingEntry.orderAt : null, 55);
  providerEntries = [];
  const completedLifecycle = await controller.observeLifecycle("codex", fixtureThreadIds["provider"], { kind: "turnCompleted", status: "completed", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") });
  assert.deepEqual(completedLifecycle, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  await controller.refresh(fixtureProjectIds["project"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const retained = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
  assert.ok(retained && retained.entryKind !== "draft");
  assert.deepEqual(retained.lifecycle, completedLifecycle);
  await controller.dispose();
});

test("accepted intent replaces only a neutral headless provider title with the first message", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-accepted-title-");
  const root = temporary.path;
  const published: WorkbenchThreadSidebarEntry[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    onProject: snapshot => {
      if (!("entries" in snapshot)) return;
      published.push(...snapshot.entries.filter((entry) => entry.entryKind !== "draft"));
    },
    reconcileProject: async () => [],
    storageRoot: root,
  });
  const providerEntry = (threadId: string, title: string): Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }> => ({
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title,
  });

  await controller.readProject(fixtureProjectIds["project"]);
  await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry("neutral", "New thread"));
  await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.neutral,
    fixtureTurnIds["neutral-turn"], "First user message");
  await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry("named", "Meaningful provider title"));
  await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.named,
    fixtureTurnIds["named-turn"], "Different user message");

  const snapshot = await controller.getSnapshot(fixtureProjectIds["project"]);
  assert.equal(snapshot.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "neutral")?.title, "First user message");
  assert.equal(snapshot.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "named")?.title, "Meaningful provider title");
  await controller.observeDisplayLabel("codex", fixtureThreadIds["neutral"], "New thread", fixtureProjectIds["project"]);
  const retained = await controller.getCanonicalThreadEntry(fixtureProjectIds["project"], fixtureThreadIds["neutral"]);
  assert.equal(retained?.title, "First user message");
  assert.deepEqual(retained?.entryKind === "thread" ? retained.titleHistory : null, []);
  assert.equal(published.filter((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "neutral").at(-1)?.title, "First user message");
  const stored = await readProjectState<{ records: Array<{ identity: { threadId: string }; title: string }> }>(root, "project");
  assert.equal(stored.records.find((entry) => entry.identity.threadId === "neutral")?.title, "First user message");
  assert.equal(stored.records.find((entry) => entry.identity.threadId === "named")?.title, "Meaningful provider title");
  await controller.dispose();
});

test("provider admission keeps a first-message display fallback separate from explicit titles", async () => {
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [],
    storageRoot: "launch-display-fallback",
    threadStateStore: new MemoryThreadStatePersistence(),
  });
  try {
    await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.thread, fixtureTurnIds.turn, "First user message");
    let entry = await controller.getCanonicalThreadEntry(fixtureProjectIds.project, fixtureThreadIds.thread);
    assert.equal(entry?.title, "First user message");
    assert.deepEqual(entry?.entryKind === "thread" ? entry.titleHistory : null, []);

    await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.thread, fixtureTurnIds.turn, "Later message");
    entry = await controller.getCanonicalThreadEntry(fixtureProjectIds.project, fixtureThreadIds.thread);
    assert.equal(entry?.title, "First user message");

    await controller.setTitle(fixtureProjectIds.project, "codex", fixtureThreadIds.thread, "Explicit title");
    await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.thread, fixtureTurnIds.turn, "Even later message");
    entry = await controller.getCanonicalThreadEntry(fixtureProjectIds.project, fixtureThreadIds.thread);
    assert.equal(entry?.title, "Explicit title");
    assert.equal(entry?.entryKind === "thread" ? entry.titleHistory?.[0]?.title : null, "Explicit title");

    await controller.ensureProviderEntry(fixtureProjectIds.project, {
      activityAt: 1,
      entryKind: "thread",
      identity: { harness: "codex", threadId: fixtureThreadIds.child },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
      title: "Provider name",
    });
    await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.child, fixtureTurnIds.turn, "First child message");
    entry = await controller.getCanonicalThreadEntry(fixtureProjectIds.project, fixtureThreadIds.child);
    assert.equal(entry?.title, "Provider name");
    assert.deepEqual(entry?.entryKind === "thread" ? entry.titleHistory : null, []);
  } finally {
    await controller.dispose();
  }
});

test("successful user input wakes snoozed threads without changing questionnaire turn order", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-user-input-wake-");
  const root = temporary.path;
  let discovered = false;
  let now = 30;
  const accepted: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 10,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["accepted"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["old-turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: true, snoozed: true },
    orderAt: 10,
    title: "Accepted",
  };
  const pending: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 20,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["pending"] },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: fixtureTurnIds["pending-turn"] },
    metadata: { archived: false, pinned: false, snoozed: true },
    orderAt: 20,
    title: "Pending",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => now,
    onProject: snapshot => {
      if ("entries" in snapshot && snapshot.entries.length === 2) discovered = true;
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [accepted, pending], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  await waitFor(() => discovered, "Snoozed threads were not discovered.");

  await controller.acceptProviderIntent(fixtureProjectIds.project, "codex", fixtureThreadIds.accepted,
    fixtureTurnIds["new-turn"], "Accepted");
  let entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "accepted");
  assert.equal(entry?.entryKind === "thread" ? entry.metadata.snoozed : null, false);
  assert.equal(entry?.entryKind === "thread" ? entry.metadata.pinned : null, true);
  assert.equal(entry?.entryKind === "thread" ? entry.orderAt : null, 30);

  now = 40;
  await controller.observeLifecycle("codex", fixtureThreadIds["pending"], { kind: "inputResolved", requestKey: "request" });
  entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "pending");
  assert.equal(entry?.entryKind === "thread" ? entry.metadata.snoozed : null, false);
  assert.equal(entry?.entryKind === "thread" ? entry.lifecycle.kind : null, "working");
  assert.equal(entry?.activityAt, 40);
  assert.equal(entry?.entryKind === "thread" ? entry.orderAt : null, 20);

  await controller.dispose();
  await temporary.dispose();
});

test("replayed questionnaire lifecycle does not invent fresh thread activity", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-questionnaire-replay-");
  const root = temporary.path;
  const publications: WorkbenchThreadSidebarSnapshot[] = [];
  let now = 20;
  const providerEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 10,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["questionnaire"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Questionnaire",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => now,
    onProject: snapshot => { publications.push(snapshot); },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [providerEntry], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  await waitFor(() => publications.some((snapshot) => "entries" in snapshot && snapshot.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "questionnaire")), "Questionnaire thread was not discovered.");
  publications.length = 0;

  await controller.observeLifecycle("codex", fixtureThreadIds["questionnaire"], { kind: "pendingInput", questionnaire: null, requestKey: "request", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") });
  let observed = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "questionnaire");
  assert.equal(observed?.activityAt, 20);
  assert.equal(publications.length, 1);

  now = 30;
  await controller.observeLifecycle("codex", fixtureThreadIds["questionnaire"], { kind: "pendingInput", questionnaire: null, requestKey: "request", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") });
  observed = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "questionnaire");
  assert.equal(observed?.activityAt, 20);
  assert.equal(publications.length, 1);

  await controller.dispose();
  await temporary.dispose();
});

test("inactive providers release stale questionnaire ownership without changing terminal semantics", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-inactive-questionnaire-");
  const root = temporary.path;
  const working = (threadId: string): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(`${threadId}-turn`) }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: threadId,
  });
  const child: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> = {
    activityAt: 1,
    createdAt: 1,
    cwd: root,
    directSubagentIndex: 0,
    entryKind: "subagent",
    identity: { harness: "codex", threadId: fixtureThreadIds["child"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["child-turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    name: "Child",
    parentThreadId: fixtureThreadIds["parent"],
    pinned: false,
    profileId: "default",
    profileName: "Default",
    projectId: fixtureProjectIds["project"],
    title: "Child",
    updatedAt: 1,
  };
  let providerEntries: WorkbenchThreadSidebarEntry[] = [working("top"), child];
  let publishedEntries: WorkbenchThreadSidebarEntry[] = [];
  let freshRevision = -1;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    onProject: snapshot => {
      if ("entries" in snapshot) publishedEntries = snapshot.entries;
      if (!("updateKind" in snapshot) && snapshot.freshness === "fresh") freshRevision = snapshot.revision;
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  await waitFor(() => publishedEntries.length === 2, "Provider threads were not discovered.");
  await controller.observeLifecycle("codex", fixtureThreadIds["top"], { kind: "pendingInput", questionnaire: null, requestKey: "top-request", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("top-turn") });
  await controller.observeLifecycle("codex", fixtureThreadIds["child"], { kind: "pendingInput", questionnaire: null, requestKey: "child-request", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("child-turn") });

  const beforeRefresh = freshRevision;
  await controller.refresh(fixtureProjectIds["project"]);
  await waitFor(() => freshRevision > beforeRefresh
    && publishedEntries.every((entry) => entry.entryKind === "draft" || entry.lifecycle.reason === "pendingInput"), "Active questionnaires lost provider ownership.");

  providerEntries = [
    { ...working("top"), lifecycle: { kind: "completed", reason: "providerInactive", settled: true } },
    { ...child, lifecycle: { kind: "completed", reason: "providerInactive", settled: false } },
  ];
  await controller.refresh(fixtureProjectIds["project"]);
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
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("top") }, method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), status: "completed",
  });
  assert.equal("result" in completed ? (completed.result as { accepted?: boolean }).accepted : false, true);
  const settled = await controller.handleRequest("observer", {
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("top") }, method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  assert.equal("result" in settled ? (settled.result as { accepted?: boolean }).accepted : false, true);
  const top = publishedEntries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "top");
  assert.equal(top?.entryKind === "thread" ? top.lifecycle.kind : null, "completed");
  assert.equal(top?.entryKind === "thread" ? top.lifecycle.settled : null, true);

  await controller.dispose();
  await temporary.dispose();
});

test("active provider observation repairs stale top-level attention", async () => {
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [],
    storageRoot: "active-attention-repair",
    threadStateStore: new MemoryThreadStatePersistence(),
  });
  const threadId = fixtureThreadIds["attention"];
  const providerEntry: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Active thread",
  };
  try {
    await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry);
    for (const event of [{ kind: "providerSystemError" } as const, { kind: "agentStatus", status: "blocked" } as const]) {
      await controller.applyLifecycle(fixtureProjectIds["project"], "codex", threadId, event);
      const stale = await controller.getCanonicalThreadEntry(fixtureProjectIds["project"], threadId);
      assert.equal(stale?.entryKind === "thread" ? stale.lifecycle.kind : null, "needsAttention");
      await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry);
      const healed = await controller.getCanonicalThreadEntry(fixtureProjectIds["project"], threadId);
      assert.deepEqual(healed?.entryKind === "thread" ? healed.lifecycle : null, providerEntry.lifecycle);
    }
  } finally {
    await controller.dispose();
  }
});

test("proper questionnaires and late-response history survive controller restarts", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-questionnaire-");
  const root = temporary.path;
  const persistence = testPersistence(root);
  const providerEntry: WorkbenchThreadSidebarEntry = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["thread"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Thread",
  };
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [providerEntry], { complete: true });
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
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  };

  const first = createController();
  await first.readProject(fixtureProjectIds["project"]);
  await waitFor(async () => (await first.getSnapshot(fixtureProjectIds["project"])).entries.length > 0, "Provider thread was not discovered.");
  const writeChanges = persistence.writeChanges.bind(persistence);
  let writes = 0;
  persistence.writeChanges = async (projectId, changes) => {
    writes += 1;
    await writeChanges(projectId, changes);
  };
  await first.observeLifecycle("codex", fixtureThreadIds["thread"], { kind: "pendingInput", questionnaire, requestKey: questionnaire.requestKey, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(questionnaire.turnId) });
  assert.equal(writes, 1);
  const pending = (await first.getSnapshot(fixtureProjectIds["project"])).entries[0];
  assert.equal(pending?.entryKind === "thread"
    ? pending.pendingQuestionnaire?.requestKey
    : null, "request-key");
  await first.dispose();

  const second = createController();
  await second.readProject(fixtureProjectIds["project"]);
  await waitFor(async () => {
    const entry = (await second.getSnapshot(fixtureProjectIds["project"])).entries.find(
      (candidate): candidate is Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => candidate.entryKind === "thread",
    );
    return entry?.pendingQuestionnaire?.requestKey === "request-key";
  }, "Persisted questionnaire was not restored after controller restart.");
  const restored = (await second.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(restored?.entryKind === "thread" ? restored.pendingQuestionnaire?.requestKey : null, "request-key");
  assert.deepEqual(second.listPendingQuestionnaires("codex"), [{
    harness: "codex",
    ...questionnaire,
    threadId: fixtureThreadIds["thread"],
  }]);
  assert.deepEqual(second.listPendingQuestionnaires("opencode"), []);
  const rejectedDismissal = await second.handleRequest("second", {
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    requestKey: "different-request",
  });
  assert.equal("result" in rejectedDismissal && (rejectedDismissal.result as { accepted?: boolean }).accepted, false);
  const dismissal = await second.handleRequest("second", {
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    requestKey: "request-key",
  });
  assert.equal("result" in dismissal && (dismissal.result as { accepted?: boolean }).accepted, true);
  const dismissed = (await second.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(dismissed?.entryKind === "thread" ? dismissed.pendingQuestionnaire ?? null : null, null);
  assert.deepEqual(dismissed?.entryKind === "thread" ? dismissed.questionnaireHistory ?? [] : null, []);
  await second.dispose();

  const third = createController();
  await third.readProject(fixtureProjectIds["project"]);
  await waitFor(async () => (await third.getSnapshot(fixtureProjectIds["project"])).entries.some((entry) => entry.entryKind === "thread"), "Dismissed questionnaire thread was not restored.");
  const reloadedDismissal = (await third.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(reloadedDismissal?.entryKind === "thread" ? reloadedDismissal.pendingQuestionnaire ?? null : null, null);
  assert.deepEqual(reloadedDismissal?.entryKind === "thread" ? reloadedDismissal.questionnaireHistory ?? [] : null, []);
  const repeatedDismissal = await third.handleRequest("third", {
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    method: "workbench/thread-state/questionnaire/dismiss",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    requestKey: "request-key",
  });
  assert.equal("result" in repeatedDismissal && (repeatedDismissal.result as { accepted?: boolean }).accepted, true);

  const unplacedQuestionnaire = { ...questionnaire, turnId: null };
  await third.observeLifecycle("codex", fixtureThreadIds["thread"], {
    kind: "pendingInput",
    questionnaire: unplacedQuestionnaire,
    requestKey: unplacedQuestionnaire.requestKey,
    turnId: null,
  });
  const response = { answers: { route: { answers: ["Approve"] } } };
  const resolutionInput = {
    harness: "codex" as const,
    insertAfterItemId: "item",
    insertAfterItemIndex: 0,
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    requestKey: unplacedQuestionnaire.requestKey,
    resolvedAt: 3,
    response,
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
  };
  await assert.rejects(
    third.resolvePendingQuestionnaire(resolutionInput, async () => {
      throw new Error("delivery failed");
    }),
    /delivery failed/u,
  );
  const retainedAfterFailure = (await third.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(retainedAfterFailure?.entryKind === "thread" ? retainedAfterFailure.pendingQuestionnaire?.requestKey : null, "request-key");

  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const repeatedKeyQuestionnaire = {
    ...questionnaire,
    itemId: "item-2",
    request: { ...questionnaire.request, id: "request-2", title: "Questionnaire 2" },
  };
  let deliveries = 0;
  const firstResolution = third.resolvePendingQuestionnaire(resolutionInput, async ({ questionnaire: deliveredQuestionnaire }) => {
    deliveries += 1;
    assert.equal(deliveredQuestionnaire.requestKey, unplacedQuestionnaire.requestKey);
    enter();
    await gate;
    await third.setMcpGeneration(fixtureProjectIds["project"], "codex", fixtureThreadIds["thread"], "questionnaire-admission");
    await third.observeLifecycle("codex", fixtureThreadIds["thread"], {
      kind: "pendingInput",
      questionnaire: repeatedKeyQuestionnaire,
      requestKey: repeatedKeyQuestionnaire.requestKey,
      turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(repeatedKeyQuestionnaire.turnId),
    });
    return {
      delivery: "delivered",
      insertAfterItemId: null,
      insertAfterItemIndex: null,
      turnId: fixtureTurnIds["turn"],
    };
  });
  await entered;
  const competingResolution = third.resolvePendingQuestionnaire(resolutionInput, async () => {
    deliveries += 1;
    return {
      delivery: "duplicate",
      insertAfterItemId: null,
      insertAfterItemIndex: null,
      turnId: fixtureTurnIds["turn"],
    };
  });
  await Promise.resolve();
  assert.equal(deliveries, 1);
  release();
  const [resolved, duplicate] = await Promise.all([firstResolution, competingResolution]);
  assert.equal(resolved?.delivery, "delivered");
  assert.equal(duplicate, null);
  assert.equal(deliveries, 1);
  const completed = (await third.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(await third.getMcpGeneration(fixtureProjectIds["project"], "codex", fixtureThreadIds["thread"]), "questionnaire-admission");
  assert.deepEqual(completed?.entryKind === "thread" ? completed.pendingQuestionnaire : null, repeatedKeyQuestionnaire);
  assert.equal(completed?.lifecycle.kind, "needsAttention");
  assert.equal(completed?.entryKind === "thread" ? completed.questionnaireHistory?.[0]?.requestKey : null, "request-key");
  assert.deepEqual(completed?.entryKind === "thread" ? completed.questionnaireHistory?.[0] : null, {
    ...unplacedQuestionnaire,
    insertAfterItemId: null,
    insertAfterItemIndex: null,
    resolvedAt: 3,
    response,
    threadId: fixtureThreadIds["thread"],
    turnId: fixtureTurnIds["turn"],
  });

  const repeatedKeyResolution = await third.handleRequest("third", {
    entry: {
      ...repeatedKeyQuestionnaire,
      insertAfterItemId: "item-2",
      insertAfterItemIndex: 1,
      resolvedAt: 4,
      response: { answers: { route: { answers: ["Continue"] } } },
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
      turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
    },
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread") },
    method: "workbench/thread-state/questionnaire/resolve",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  assert.equal("result" in repeatedKeyResolution && (repeatedKeyResolution.result as { accepted?: boolean }).accepted, true);
  const repeatedKeyHistory = (await third.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread");
  assert.deepEqual(
    repeatedKeyHistory?.entryKind === "thread"
      ? repeatedKeyHistory.questionnaireHistory?.map((entry) => entry.itemId)
      : null,
    ["item", "item-2"],
  );
  await third.dispose();

  const fourth = createController();
  await fourth.readProject(fixtureProjectIds["project"]);
  await waitFor(async () => {
    const entry = (await fourth.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread");
    return entry?.entryKind === "thread" && entry.questionnaireHistory?.[0]?.requestKey === "request-key";
  }, "Persisted questionnaire history was not restored after controller restart.");
  const reloaded = (await fourth.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(reloaded?.entryKind === "thread" ? reloaded.pendingQuestionnaire ?? null : null, null);
  assert.equal(reloaded?.entryKind === "thread" ? reloaded.questionnaireHistory?.[0]?.response.answers.route?.answers[0] : null, "Approve");
  assert.deepEqual(
    reloaded?.entryKind === "thread"
      ? reloaded.questionnaireHistory?.map((entry) => entry.itemId)
      : null,
    ["item", "item-2"],
  );
  await fourth.dispose();
  await temporary.dispose();
});

test("wake waits for every unsnoozed row to become settlement-ready, then wakes only the highest projected root snoozed thread", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-one-wake-");
  const root = temporary.path;
  const snoozed = (threadId: string, orderAt: number): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: true },
    orderAt,
    title: threadId,
  });
  const providerEntries: WorkbenchThreadSidebarEntry[] = [
    snoozed("a", 3), snoozed("b", 2), snoozed("c", 9),
    {
      activityAt: 4, createdAt: 4, cwd: root, directSubagentIndex: 0, entryKind: "subagent",
      identity: { harness: "codex", threadId: fixtureThreadIds["child"] },
      lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["child-turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
      name: "child", parentThreadId: fixtureThreadIds["parent"], pinned: false, profileId: "default", profileName: "Default",
      projectId: fixtureProjectIds["project"], title: "child", updatedAt: 4,
    },
    {
      activityAt: 5,
      entryKind: "thread",
      identity: { harness: "codex", threadId: fixtureThreadIds["attention"] },
      lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false },
      title: "attention",
    },
  ];
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  const folderId = "00000000-0000-4000-8000-000000000042";
  await seedProjectState(root, "project", {
    version: 4, records: providerEntries, drafts: [],
    displayOrder: { folders: [{ folderId, section: "snoozed", threadKeys: ["codex:c"], title: "Keep asleep" }] },
  });
  const controller = createController();
  await controller.readProject(fixtureProjectIds["project"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).entries.length === providerEntries.length, "Threads were not discovered.");
  const afterReorder = await readProjectState<{ displayOrder?: unknown }>(root, "project");
  assert.ok(afterReorder.displayOrder);
  await controller.observeLifecycle("codex", fixtureThreadIds["child"], { kind: "turnCompleted", status: "completed", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("child-turn") });
  const blockedSnoozeState = new Map((await controller.getSnapshot(fixtureProjectIds["project"])).entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(blockedSnoozeState.get(fixtureThreadIds["a"]), true);
  assert.equal(blockedSnoozeState.get(fixtureThreadIds["b"]), true);
  assert.equal(blockedSnoozeState.get(fixtureThreadIds["c"]), true);
  await controller.observeLifecycle("codex", fixtureThreadIds["attention"], { kind: "userCompleted" });
  const snoozeState = new Map((await controller.getSnapshot(fixtureProjectIds["project"])).entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(snoozeState.get(fixtureThreadIds["c"]), true);
  assert.equal(snoozeState.get(fixtureThreadIds["a"]), false);
  assert.equal(snoozeState.get(fixtureThreadIds["b"]), true);
  const afterWake = await readProjectState<{ displayOrder?: { folders?: Array<{ threadKeys: string[] }> } }>(root, "project");
  assert.deepEqual(afterWake.displayOrder?.folders?.[0]?.threadKeys, ["codex:c"]);
  await controller.dispose();

  const reopened = createController();
  await reopened.readProject(fixtureProjectIds["project"]);
  await waitFor(async () => (await reopened.getSnapshot(fixtureProjectIds["project"])).entries.length === providerEntries.length, "Reopened threads were not discovered.");
  const reopenedSnapshot = await reopened.getSnapshot(fixtureProjectIds["project"]);
  const reopenedSnoozeState = new Map(reopenedSnapshot.entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(reopenedSnoozeState.get(fixtureThreadIds["c"]), true);
  assert.equal(reopenedSnoozeState.get(fixtureThreadIds["a"]), false);
  assert.equal(reopenedSnoozeState.get(fixtureThreadIds["b"]), true);
  assert.deepEqual(reopenedSnapshot.displayOrder.folders?.[0]?.threadKeys, ["codex:c"]);
  await reopened.dispose();
  await temporary.dispose();
});

test("retained legacy folders reconcile members that leave their section", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-folders-");
  const root = temporary.path;
  const pinned = (threadId: string, orderAt: number): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: orderAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: true, snoozed: false },
    orderAt,
    title: threadId,
  });
  const providerEntries: WorkbenchThreadSidebarEntry[] = [pinned("a", 2), pinned("b", 1)];
  const createController = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  const folderId = "00000000-0000-4000-8000-000000000030";
  await seedProjectState(root, "project", {
    version: 4, drafts: [], records: providerEntries,
    displayOrder: { folders: [{ folderId, section: "pinned", title: "Important", threadKeys: ["codex:a", "codex:b"] }] },
  });
  const reopened = createController();
  await reopened.readProject(fixtureProjectIds["project"]);
  const restoredFolder = (await reopened.getSnapshot(fixtureProjectIds["project"])).displayOrder?.folders?.[0];
  assert.equal(restoredFolder?.title, "Important");
  assert.deepEqual(restoredFolder?.threadKeys, ["codex:a", "codex:b"]);
  await reopened.handleRequest("reopened", { identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("b") }, method: "workbench/thread-state/pin/set", pinned: false, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") });
  assert.deepEqual((await reopened.getSnapshot(fixtureProjectIds["project"])).displayOrder?.folders?.[0]?.threadKeys, ["codex:a"]);
  await reopened.handleRequest("reopened", { identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("a") }, method: "workbench/thread-state/pin/set", pinned: false, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") });
  assert.deepEqual((await reopened.getSnapshot(fixtureProjectIds["project"])).displayOrder, {});
  await reopened.dispose();
  await temporary.dispose();
});

test("a held questionnaire never leaves the thread in the automatic recovery state", async () => {
  const question = {
    itemId: "3d9b1f6a-2f2e-4a4e-9f2d-6b1c0f5a7c11",
    requestKey: "held-question",
    turnId: fixtureTurnIds["turn"],
    request: {
      id: "held-question",
      title: "Choose",
      summary: "",
      submitLabel: "Submit",
      questions: [{ id: "choice", header: "choice", question: "Proceed?", options: [], allowOther: true, isSecret: false }],
    },
  };
  const waiting: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["questionnaire"] },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: question.requestKey, settled: false, turnId: fixtureTurnIds["turn"] },
    metadata: { archived: false, pinned: false, snoozed: false },
    pendingQuestionnaire: question,
    title: "Waiting",
  };
  const settled: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["retained"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Settled",
  };
  const controller = new WorkbenchThreadStateController({
    storageRoot: "held-questionnaire-recovery",
    threadStateStore: new MemoryThreadStatePersistence(),
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_projectId, _signal, accept) => {
      await accept("codex", [waiting, settled], { complete: true });
      return [];
    },
  });
  const recovery = new WorkbenchTurnRecoveryController(() => undefined);
  const readEntry = async (threadId: typeof fixtureThreadIds["questionnaire"]) => {
    const entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find(
      candidate => candidate.entryKind === "thread" && candidate.identity.threadId === threadId,
    );
    assert.ok(entry && entry.entryKind === "thread");
    return entry;
  };
  const waitingRequestKey = (entry: Awaited<ReturnType<typeof readEntry>>) =>
    entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput"
      ? entry.lifecycle.requestKey : null;
  try {
    await controller.readProject(fixtureProjectIds["project"]);
    await controller.refresh(fixtureProjectIds["project"]);

    // A provider failure walks an idle thread to needsAttention/noActiveTurn, the one state the
    // shared recovery gate treats as resumable. A thread waiting on a question must not become it.
    await controller.observeLifecycle("codex", fixtureThreadIds["questionnaire"], { kind: "providerSystemError" });
    let entry = await readEntry(fixtureThreadIds["questionnaire"]);
    assert.equal(waitingRequestKey(entry), question.requestKey);
    assert.equal(recovery.shouldContinue(entry.lifecycle, false), false);

    // A completed turn must not walk it there either, and the question stays answerable.
    await controller.observeLifecycle("codex", fixtureThreadIds["questionnaire"], { kind: "turnCompleted", status: "completed", turnId: fixtureTurnIds["turn"] });
    entry = await readEntry(fixtureThreadIds["questionnaire"]);
    assert.equal(waitingRequestKey(entry), question.requestKey);
    assert.equal(recovery.shouldContinue(entry.lifecycle, false), false);
    assert.equal(entry.pendingQuestionnaire?.requestKey, question.requestKey);

    // A question observed without an owning turn still asserts the waiting state.
    const turnless = { ...question, itemId: "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b", requestKey: "turnless-question", turnId: null };
    await controller.observeLifecycle("codex", fixtureThreadIds["retained"], {
      kind: "pendingInput", questionnaire: turnless, requestKey: turnless.requestKey, turnId: null,
    });
    const turnlessEntry = await readEntry(fixtureThreadIds["retained"]);
    assert.equal(waitingRequestKey(turnlessEntry), turnless.requestKey);
    assert.equal(recovery.shouldContinue(turnlessEntry.lifecycle, false), false);
  } finally {
    await controller.dispose();
  }
});

test("profile-less threads use defaults and reads cannot overtake a failed profile save", async (context) => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-profile-admission-");
  const root = temporary.path;
  let failWrite = false;
  let release!: () => void;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const persistence = new MemoryThreadStatePersistence();
  const write = persistence.writeChanges.bind(persistence);
  persistence.writeChanges = async (projectId, changes) => {
    if (failWrite) {
      entered();
      await gate;
      throw new Error("Profile disk failure");
    }
    await write(projectId, changes);
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [], storageRoot: root, threadStateStore: persistence,
  });
  context.after(async () => { release(); await controller.dispose(); await temporary.dispose(); });
  const defaultSlot = { kind: "new-thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") };
  const threadSlot = { kind: "thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("existing") };
  const original = { kind: "custom" as const, settings: { ...EMPTY_CODEX_SETTINGS, model: "saved-model" } };
  await controller.ensureProviderEntry(fixtureProjectIds["project"], pinnedRecord("existing", "Existing"));
  await controller.setComposerProfileTarget(defaultSlot, original);
  assert.deepEqual(await controller.readComposerProfileTarget(threadSlot), original);
  failWrite = true;
  const saving = controller.setComposerProfileTarget(defaultSlot, { kind: "custom", settings: { ...original.settings, model: "unsaved-model" } });
  const rejectedSave = assert.rejects(saving, /Profile disk failure/u);
  await writing;
  const reading = controller.readComposerProfileTarget(defaultSlot);
  const rejectedRead = assert.rejects(reading, /Profile disk failure/u);
  const rejectedAdmission = assert.rejects(controller.prepareComposerProfileTarget(threadSlot), /Profile disk failure/u);
  release();
  await Promise.all([rejectedSave, rejectedRead, rejectedAdmission]);
  assert.deepEqual(await controller.readComposerProfileTarget(defaultSlot), original);
});

test("restarted preview refreshes linked profiles, retains deleted snapshots and recovers subagent profiles", async (context) => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-profile-restart-");
  const root = temporary.path;
  const persistence = new MemoryThreadStatePersistence();
  let profiles: WorkbenchComposerProfile[] = [{
    ...EMPTY_CODEX_SETTINGS, id: "named", name: "Named", model: "original",
    createdAt: 1, updatedAt: 1, scope: { kind: "global" },
  }];
  const create = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    readComposerProfiles: async () => ({ profiles }),
    reconcileProject: async () => [], storageRoot: root, threadStateStore: persistence,
  });
  const first = create();
  const slot = { kind: "thread" as const, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("existing") };
  const selection = { kind: "profile" as const, profileId: "named", settings: { ...EMPTY_CODEX_SETTINGS, model: "original" } };
  await first.ensureProviderEntry(fixtureProjectIds["project"], pinnedRecord("existing", "Existing"));
  await first.setComposerProfileTarget(slot, selection);
  await first.dispose();
  profiles = [{ ...profiles[0]!, agentPath: "library:agents/lily.md", agentSource: "library", model: "latest" }];
  const restarted = create();
  context.after(async () => { await restarted.dispose(); await temporary.dispose(); });
  const effective = await restarted.readComposerProfileTarget(slot);
  assert.equal(effective?.settings.model, "latest");
  const candidate = (await restarted.prepareComposerProfileTarget(slot)).selection;
  assert.equal(candidate.settings.agentPath, "library:agents/lily.md");
  assert.equal(candidate.settings.model, "latest");
  assert.deepEqual(await restarted.readComposerProfileTarget(slot), candidate);
  profiles = [];
  assert.deepEqual((await restarted.prepareComposerProfileTarget(slot)).selection, { kind: "custom", settings: selection.settings });
  profiles = [{ ...selection.settings, id: "named", name: "Named", harness: "copilot", createdAt: 1, updatedAt: 1, scope: { kind: "global" } }];
  assert.deepEqual((await restarted.prepareComposerProfileTarget(slot)).selection, { kind: "custom", settings: selection.settings });
  profiles = [];
  await restarted.setComposerProfileTarget({ kind: "new-thread", projectId: fixtureProjectIds["project"] }, selection);
  const child: Extract<WorkbenchThreadSidebarEntry, { entryKind: "subagent" }> = {
    activityAt: 1, title: "Child", identity: { harness: "codex", threadId: fixtureThreadIds["child"] },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    entryKind: "subagent", createdAt: 1, cwd: root,
    directSubagentIndex: 0, name: "child", parentThreadId: fixtureThreadIds["existing"], profileId: "missing",
    profileName: "Child", pinned: false, projectId: fixtureProjectIds["project"], updatedAt: 1,
  };
  await restarted.ensureProviderEntry(fixtureProjectIds["project"], child);
  const childSlot = { ...slot, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child") };
  await assert.rejects(restarted.prepareComposerProfileTarget(childSlot), /no available daemon composer profile/u);
  profiles = [{ ...selection.settings, id: "missing", name: "Child", createdAt: 1, updatedAt: 1, scope: { kind: "global" } }];
  assert.equal((await restarted.prepareComposerProfileTarget(childSlot)).selection.settings.model, "original");
  await restarted.setComposerProfileTarget(childSlot, { ...selection, profileId: "missing" });
  assert.equal((await restarted.prepareComposerProfileTarget(childSlot)).selection.kind, "profile");
  await restarted.ensureProviderEntry(fixtureProjectIds["project"], pinnedRecord("child", "Provider child"));
  assert.equal((await restarted.prepareComposerProfileTarget(childSlot)).subagentName, "child");
  profiles = [{ ...profiles[0]!, harness: "copilot" }];
  // The linked definition drifted providers; the child previews its saved Custom snapshot instead of throwing.
  assert.deepEqual((await restarted.prepareComposerProfileTarget(childSlot)).selection, { kind: "custom", settings: selection.settings });
});

test("profile admission publishes only accepted candidates and orders later edits without blocking lifecycle writes", async (context) => {
  const persistence = new MemoryThreadStatePersistence();
  const usage: Array<{ id: string; at: number }> = [];
  const modelUsage: Array<{ harness: string; model: string; at: number }> = [];
  const original = { kind: "profile" as const, profileId: "named", settings: { ...EMPTY_CODEX_SETTINGS, model: "old" } };
  const latest = { ...original.settings, model: "new" };
  const controller = new WorkbenchThreadStateController({
    storageRoot: "profile-admission", threadStateStore: persistence,
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [],
    now: () => 1234,
    recordComposerProfileUsage: async (id: string, at: number) => { usage.push({ id, at }); },
    recordComposerModelUsage: async (harness, model, at) => { modelUsage.push({ harness, model, at }); },
    readComposerProfiles: async () => ({ profiles: [{ ...latest, id: "named", name: "Named", scope: { kind: "global" }, createdAt: 1, updatedAt: 1 }] }),
  });
  context.after(() => controller.dispose());
  const slot = { kind: "thread" as const, projectId: fixtureProjectIds["project"], harness: "codex" as const, threadId: fixtureThreadIds["existing"] };
  await controller.ensureProviderEntry(slot.projectId, pinnedRecord("existing", "Existing"));
  await controller.setComposerProfileTarget(slot, original);
  const signal = new AbortController().signal;
  const rejected = await controller.withComposerProfileAdmission(slot, async ({ selection }) => {
    assert.equal(selection.settings.model, latest.model);
    return { accepted: false, result: "not sent" };
  }, signal);
  assert.equal(rejected.accepted, false);
  assert.deepEqual(await controller.readComposerProfileSnapshot(slot), original);
  assert.deepEqual((await controller.readComposerProfileTarget(slot))?.settings, latest);
  await assert.rejects(controller.withComposerProfileAdmission(slot, async () => {
    throw new Error("Native start failed");
  }, signal), /Native start failed/);
  assert.deepEqual(await controller.readComposerProfileSnapshot(slot), original);
  assert.deepEqual((await controller.readComposerProfileTarget(slot))?.settings, latest);
  assert.deepEqual(usage, []);
  assert.deepEqual(modelUsage, []);
  const accepted = await controller.withComposerProfileAdmission(slot, async () => ({ accepted: true, result: "sent" }), signal);
  assert.equal(accepted.profilePersistenceError, null);
  assert.deepEqual(usage, [{ id: "named", at: 1234 }]);
  assert.deepEqual(modelUsage, [{ harness: "codex", model: "new", at: 1234 }]);
  assert.deepEqual((await controller.readComposerProfileTarget(slot))?.settings, latest);

  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  context.after(() => release());
  const admission = controller.withComposerProfileAdmission(slot, async () => {
    enter();
    await gate;
    return { accepted: true, result: "sent again" };
  }, signal);
  await entered;
  const edited = { kind: "custom" as const, settings: { ...latest, model: "user-edit" } };
  const edit = controller.setComposerProfileTarget(slot, edited);
  await controller.setTitle(slot.projectId, slot.harness, slot.threadId, "Event update");
  release();
  await Promise.all([admission, edit]);
  assert.deepEqual(await controller.readComposerProfileTarget(slot), edited);
});

test("usage failure retains accepted success and still saves the applied profile", async (context) => {
  const persistence = new MemoryThreadStatePersistence();
  const logs: string[] = [];
  let usages = 0;
  const original = { kind: "profile" as const, profileId: "named", settings: { ...EMPTY_CODEX_SETTINGS, model: "old" } };
  const controller = new WorkbenchThreadStateController({
    storageRoot: "profile-usage-failure", threadStateStore: persistence,
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [], log: message => logs.push(message),
    readComposerProfiles: async () => ({ profiles: [{ ...original.settings, model: "new", id: "named", name: "Named", scope: { kind: "global" }, createdAt: 1, updatedAt: 1 }] }),
    recordComposerProfileUsage: async () => { usages++; throw new Error("Usage unavailable"); },
  });
  context.after(() => controller.dispose());
  const slot = { kind: "thread" as const, projectId: fixtureProjectIds["project"], harness: "codex" as const, threadId: fixtureThreadIds["existing"] };
  await controller.ensureProviderEntry(slot.projectId, pinnedRecord("existing", "Existing"));
  await controller.setComposerProfileTarget(slot, original);
  const outcome = await controller.withComposerProfileAdmission(slot, async () => ({ accepted: true, result: "native" }), new AbortController().signal);
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.result, "native");
  assert.ok(outcome.profilePersistenceError);
  assert.ok(logs.length);
  assert.equal((await controller.readComposerProfileSnapshot(slot))?.settings.model, "new");
  await controller.setComposerProfileTarget(slot, { kind: "custom", settings: original.settings });
  await controller.withComposerProfileAdmission(slot, async () => ({ accepted: true, result: "custom" }), new AbortController().signal);
  assert.equal(usages, 1);
  await controller.setComposerProfileTarget(slot, original);
  persistence.writeChanges = async () => { throw new Error("Snapshot unavailable"); };
  const bothFailed = await controller.withComposerProfileAdmission(slot, async () => ({ accepted: true, result: "native-again" }), new AbortController().signal);
  assert.equal(bothFailed.accepted, true);
  assert.match(bothFailed.profilePersistenceError ?? "", /Snapshot unavailable/);
  assert.match(bothFailed.profilePersistenceError ?? "", /Usage unavailable/);
});

test("profile persistence failure after native acceptance retains success and exposes the failed snapshot write", async (context) => {
  const persistence = new MemoryThreadStatePersistence();
  const logs: string[] = [];
  const controller = new WorkbenchThreadStateController({
    storageRoot: "profile-failed-commit", threadStateStore: persistence,
    getProjectCatalog: projectCatalog,
    reconcileProject: async () => [], log: (message) => logs.push(message),
  });
  context.after(() => controller.dispose());
  const slot = { kind: "thread" as const, projectId: fixtureProjectIds["project"], harness: "codex" as const, threadId: fixtureThreadIds["existing"] };
  await controller.ensureProviderEntry(slot.projectId, pinnedRecord("existing", "Existing"));
  const original = { kind: "custom" as const, settings: { ...EMPTY_CODEX_SETTINGS, model: "saved" } };
  await controller.setComposerProfileTarget(slot, original);
  persistence.writeChanges = async () => { throw new Error("Disk unavailable"); };
  const accepted = await controller.withComposerProfileAdmission(slot, async () => ({ accepted: true, result: "native-turn" }), new AbortController().signal);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.result, "native-turn");
  assert.ok(accepted.profilePersistenceError);
  assert.ok(logs.length);
  assert.deepEqual(await controller.readComposerProfileTarget(slot), original);
});

test("priority transitions retain pins while snoozed and clear both when returning to main", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-drag-priority-");
  const root = temporary.path;
  const source: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["source"] },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Source",
  };
  const target: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...source,
    activityAt: 1,
    identity: { harness: "codex", threadId: fixtureThreadIds["target"] },
    metadata: { archived: false, pinned: false, snoozed: true },
    title: "Target",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [source, target], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).freshness === "fresh", "Project did not reconcile.");

  const crossPriorityMove = await controller.handleRequest("observer", {
    method: "workbench/thread-state/priority/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    priority: "snoozed",
    sourceKey: "codex:source",
  });
  assert.equal("result" in crossPriorityMove && (crossPriorityMove.result as { accepted?: boolean }).accepted, true);
  let snapshot = await controller.getSnapshot(fixtureProjectIds["project"]);
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
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    sourceKey: "codex:source",
  });
  moved = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "source");
  assert.deepEqual(moved?.entryKind === "thread" ? moved.metadata : null, { archived: false, pinned: true, snoozed: false });

  const snoozed = await controller.handleRequest("observer", {
    method: "workbench/thread-state/priority/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    priority: "snoozed",
    sourceKey: "codex:source",
  });
  assert.equal("result" in snoozed && (snoozed.result as { accepted?: boolean }).accepted, true);
  snapshot = await controller.getSnapshot(fixtureProjectIds["project"]);
  moved = snapshot.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "source");
  assert.deepEqual(moved?.entryKind === "thread" ? moved.metadata : null, { archived: false, pinned: true, snoozed: true });

  await controller.handleRequest("observer", {
    method: "workbench/thread-state/priority/set",
    priority: "main",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    sourceKey: "codex:source",
  });
  moved = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "source");
  assert.deepEqual(moved?.entryKind === "thread" ? moved.metadata : null, { archived: false, pinned: false, snoozed: false });
  await controller.dispose();
  await temporary.dispose();
});

test("cross-project dependent snooze waits for completion and the final live claim", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-dependent-snooze-");
  const root = temporary.path;
  const source: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["source"] },
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
    identity: { harness: "codex", threadId: fixtureThreadIds["target"] },
    title: "Target",
  };
  let targetArc: typeof claimedArc | null = claimedArc;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/projects/alpha"), projectOption("beta", "C:/projects/beta")],
      rootPath: "C:/projects",
    }),
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot, acceptGitArcSnapshot) => {
      await acceptProviderSnapshot("codex", projectId === "alpha" ? [source] : [target], { complete: true });
      await acceptGitArcSnapshot({
        arcs: projectId === "beta" && targetArc ? [{ harness: "codex", state: targetArc, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("target") }] : [],
        plans: [],
      });
      return [];
    },
    resolveGitArc: async (_projectId, _harness, threadId) => threadId === "target" ? targetArc : null,
    storageRoot: root,
  });
  await Promise.all([controller.readProject(fixtureProjectIds.alpha), controller.readProject(fixtureProjectIds.beta)]);
  await waitFor(async () => (
    (await controller.getSnapshot(fixtureProjectIds["alpha"])).freshness === "fresh"
    && (await controller.getSnapshot(fixtureProjectIds["beta"])).freshness === "fresh"
  ), "Projects did not reconcile.");
  await controller.handleRequest("observer", {
    identity: source.identity,
    method: "workbench/thread-state/snooze/until",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    target: { identity: target.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") },
  });
  await controller.observeLifecycle("codex", fixtureThreadIds["target"], { kind: "userCompleted" });
  let sourceEntry = (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(sourceEntry?.entryKind === "thread" ? sourceEntry.metadata.snoozed : null, true);
  const stored = await readProjectState<{ records: Array<{ snoozedUntil?: unknown }> }>(root, "alpha");
  assert.deepEqual(stored.records[0]?.snoozedUntil, { targets: [{
    identity: target.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), title: target.title,
  }] });

  targetArc = null;
  await controller.refreshGitArcState(fixtureProjectIds["beta"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("target"));
  sourceEntry = (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(sourceEntry?.entryKind === "thread" ? sourceEntry.metadata.snoozed : null, false);
  const storedAfterWake = await readProjectState<{ records: Array<{ snoozedUntil?: unknown }> }>(root, "alpha");
  assert.equal(storedAfterWake.records[0]?.snoozedUntil, null);
  await controller.dispose();
  await temporary.dispose();
});

test("dependent snooze also wakes when claims leave before manual completion", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-dependent-snooze-claims-first-");
  const root = temporary.path;
  const source: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["source"] },
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
    identity: { harness: "codex", threadId: fixtureThreadIds["target"] },
    title: "Target",
  };
  let targetArc: typeof claimedArc | null = claimedArc;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/projects/alpha"), projectOption("beta", "C:/projects/beta")],
      rootPath: "C:/projects",
    }),
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot, acceptGitArcSnapshot) => {
      await acceptProviderSnapshot("codex", projectId === "alpha" ? [source] : [target], { complete: true });
      await acceptGitArcSnapshot({
        arcs: projectId === "beta" && targetArc ? [{ harness: "codex", state: targetArc, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("target") }] : [],
        plans: [],
      });
      return [];
    },
    resolveGitArc: async (_projectId, _harness, threadId) => threadId === "target" ? targetArc : null,
    storageRoot: root,
  });
  await Promise.all([controller.readProject(fixtureProjectIds.alpha), controller.readProject(fixtureProjectIds.beta)]);
  await waitFor(async () => (
    (await controller.getSnapshot(fixtureProjectIds["alpha"])).freshness === "fresh"
    && (await controller.getSnapshot(fixtureProjectIds["beta"])).freshness === "fresh"
  ), "Projects did not reconcile.");
  await controller.handleRequest("observer", {
    identity: source.identity,
    method: "workbench/thread-state/snooze/until",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    target: { identity: target.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") },
  });

  targetArc = null;
  await controller.refreshGitArcState(fixtureProjectIds["beta"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("target"));
  let sourceEntry = (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(sourceEntry?.entryKind === "thread" ? sourceEntry.metadata.snoozed : null, true);

  await controller.handleRequest("observer", {
    identity: target.identity,
    method: "workbench/thread-state/status/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
    status: "completed",
  });
  sourceEntry = (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.find((entry) => entry.entryKind === "thread");
  assert.equal(sourceEntry?.entryKind === "thread" ? sourceEntry.metadata.snoozed : null, false);
  const stored = await readProjectState<{ records: Array<{ snoozedUntil?: unknown }> }>(root, "alpha");
  assert.equal(stored.records[0]?.snoozedUntil, null);
  await controller.dispose();
  await temporary.dispose();
});

test("dependent snooze keeps multiple targets, survives missing targets, and clears manually", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-dependent-snooze-clearing-");
  const root = temporary.path;
  const thread = (
    threadId: string,
    metadata: { archived: false; pinned: false; snoozed: boolean },
    lifecycle: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }>["lifecycle"],
    activityAt: number,
  ): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle,
    metadata,
    title: threadId,
  });
  const source = thread("source", { archived: false, pinned: false, snoozed: false }, { kind: "completed", reason: "providerInactive", settled: false }, 4);
  const ordinary = thread("ordinary", { archived: false, pinned: false, snoozed: true }, { kind: "completed", reason: "providerInactive", settled: false }, 3);
  const active = thread("active", { archived: false, pinned: false, snoozed: false }, {
    agent: { agentStatus: "working", turnId: fixtureTurnIds["active-turn"] },
    kind: "working",
    reason: "acceptedIntent",
    settled: false,
  }, 5);
  const targetA = thread("target-a", { archived: false, pinned: false, snoozed: false }, { kind: "needsAttention", reason: "noActiveTurn", settled: false }, 2);
  const targetB = thread("target-b", { archived: false, pinned: false, snoozed: false }, { kind: "needsAttention", reason: "noActiveTurn", settled: false }, 1);
  let betaEntries = [targetA, targetB];
  const publications: WorkbenchThreadSidebarSnapshot[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/projects/alpha"), projectOption("beta", "C:/projects/beta")],
      rootPath: "C:/projects",
    }),
    onProject: snapshot => { publications.push(snapshot); },
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", projectId === "alpha" ? [source, ordinary, active] : betaEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await Promise.all([controller.readProject(fixtureProjectIds.alpha), controller.readProject(fixtureProjectIds.beta)]);
  await waitFor(async () => (
    (await controller.getSnapshot(fixtureProjectIds["alpha"])).freshness === "fresh"
    && (await controller.getSnapshot(fixtureProjectIds["beta"])).freshness === "fresh"
  ), "Projects did not reconcile.");

  for (const target of [targetA, targetB]) {
    await controller.handleRequest("observer", {
      identity: source.identity,
      method: "workbench/thread-state/snooze/until",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
      target: { identity: target.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") },
    });
  }
  let stored = await readProjectState<{ records: Array<{ identity: { threadId: string }; snoozedUntil?: unknown }> }>(root, "alpha");
  assert.deepEqual(
    stored.records.find(({ identity }) => identity.threadId === "source")?.snoozedUntil,
    { targets: [targetA, targetB].map(target => ({
      identity: target.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), title: target.title,
    })) },
  );
  const waitingEntry = (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.find(
    entry => entry.entryKind === "thread" && entry.identity.threadId === source.identity.threadId,
  );
  assert.equal(waitingEntry?.entryKind === "thread" ? waitingEntry.waitingFor : null, "other");
  assert.deepEqual(waitingEntry?.entryKind === "thread"
    ? waitingEntry.waitingOnThreads?.map(wait => wait.identity.threadId) : null,
  [targetA.identity.threadId, targetB.identity.threadId]);
  const observeSource = async () => {
    const response = await controller.readWorkspaceThread({
      projectId: fixtureProjectIds["alpha"],
      subscriptionId: crypto.randomUUID(),
      target: { harness: "codex", kind: "provider", threadId: source.identity.threadId },
    });
    return response.entries[0];
  };
  const newObservation = await observeSource();
  assert.equal(newObservation?.entryKind === "thread" ? newObservation.waitingOnThreads?.length : null, 2);
  await controller.handleRequest("observer", {
    identity: source.identity,
    method: "workbench/thread-state/snooze/until",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    target: { identity: targetB.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") },
  });
  stored = await readProjectState<{ records: Array<{ identity: { threadId: string }; snoozedUntil?: unknown }> }>(root, "alpha");
  assert.deepEqual(stored.records.find(({ identity }) => identity.threadId === "source")?.snoozedUntil, {
    targets: [{ identity: targetA.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), title: targetA.title }],
  });
  const newPublishedSource = publications.findLast(publication => publication.projectId === fixtureProjectIds.alpha)
    ?.entries.find(entry => entry.entryKind === "thread" && entry.identity.threadId === source.identity.threadId);
  assert.equal(newPublishedSource?.entryKind === "thread" ? newPublishedSource.waitingOnThreads?.length : null, 1);
  await controller.handleRequest("observer", {
    identity: source.identity,
    method: "workbench/thread-state/snooze/until",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    target: { identity: targetB.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") },
  });
  await controller.handleRequest("observer", {
    identity: targetA.identity,
    method: "workbench/thread-state/status/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
    status: "completed",
  });
  stored = await readProjectState<{ records: Array<{ identity: { threadId: string }; snoozedUntil?: unknown }> }>(root, "alpha");
  assert.deepEqual(stored.records.find(({ identity }) => identity.threadId === "source")?.snoozedUntil, {
    targets: [{ identity: targetB.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), title: targetB.title }],
  });
  const partiallyWaiting = (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.find(
    entry => entry.entryKind === "thread" && entry.identity.threadId === source.identity.threadId,
  );
  assert.equal(partiallyWaiting?.entryKind === "thread" ? partiallyWaiting.metadata.snoozed : null, true);
  assert.deepEqual(partiallyWaiting?.entryKind === "thread"
    ? partiallyWaiting.waitingOnThreads?.map(wait => wait.identity.threadId) : null,
  [targetB.identity.threadId]);

  betaEntries = [];
  await controller.refresh(fixtureProjectIds["beta"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["beta"])).freshness === "fresh", "Target removal did not reconcile.");
  await controller.observeLifecycle("codex", fixtureThreadIds["active"], { kind: "userCompleted" });
  const snoozeState = new Map((await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.flatMap((entry) => (
    entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []
  )));
  assert.equal(snoozeState.get(fixtureThreadIds["source"]), true);
  assert.equal(snoozeState.get(fixtureThreadIds["ordinary"]), false);

  await controller.handleRequest("observer", {
    identity: source.identity,
    method: "workbench/thread-state/snooze/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    snoozed: false,
  });
  stored = await readProjectState<{ records: Array<{ identity: { threadId: string }; snoozedUntil?: unknown }> }>(root, "alpha");
  assert.equal(stored.records.find(({ identity }) => identity.threadId === "source")?.snoozedUntil, null);
  const concurrentTargets = ["concurrent-a", "concurrent-b"].map(threadId => thread(
    threadId, { archived: false, pinned: false, snoozed: false },
    { kind: "needsAttention", reason: "noActiveTurn", settled: false }, 6,
  ));
  betaEntries = concurrentTargets;
  await controller.refresh(fixtureProjectIds["beta"]);
  for (const target of concurrentTargets) {
    await controller.handleRequest("observer", {
      identity: source.identity, method: "workbench/thread-state/snooze/until",
      projectId: fixtureProjectIds["alpha"],
      target: { identity: target.identity, projectId: fixtureProjectIds["beta"] },
    });
  }
  await Promise.all(concurrentTargets.map(target => controller.handleRequest("observer", {
    identity: target.identity, method: "workbench/thread-state/status/set",
    projectId: fixtureProjectIds["beta"], status: "completed",
  })));
  const afterBoth = (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.find(
    entry => entry.entryKind === "thread" && entry.identity.threadId === source.identity.threadId,
  );
  assert.equal(afterBoth?.entryKind === "thread" ? afterBoth.metadata.snoozed : null, false);
  assert.deepEqual(afterBoth?.entryKind === "thread" ? afterBoth.waitingOnThreads : null, []);
  await controller.dispose();
  await temporary.dispose();
});

test("restart reevaluates a persisted dependency when its ready target loaded first", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-dependent-snooze-restart-");
  const root = temporary.path;
  const source: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 2,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["source"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: true },
    title: "Source",
  };
  const target: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...source,
    activityAt: 1,
    identity: { harness: "codex", threadId: fixtureThreadIds["target"] },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Target",
  };
  const persistence = testPersistence(root);
  await persistence.writeProject("alpha", {
    drafts: [],
    records: [{ ...source, snoozedUntil: { identity: target.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") } }],
    version: 4,
  });
  await persistence.writeProject("beta", { drafts: [], records: [target], version: 4 });
  let releaseSourceRead = () => undefined;
  const sourceReadGate = new Promise<void>((resolve) => { releaseSourceRead = resolve; });
  const gatedPersistence: WorkbenchThreadStatePersistence = {
    readNavigationSummary: projectId => persistence.readNavigationSummary(projectId),
    writeChanges: (projectId, changes) => persistence.writeChanges(projectId, changes),
    readNextArchiveEligibility: () => persistence.readNextArchiveEligibility(),
    readArchiveEligible: before => persistence.readArchiveEligible(before),
    readGlobal: async (id) => await persistence.readGlobal(id),
    readTitleHistories: async (projectId) => await persistence.readTitleHistories(projectId),
    readProject: async (projectId) => {
      if (projectId === "alpha") await sourceReadGate;
      return await persistence.readProject(projectId);
    },
    writeGlobal: async (id, document) => await persistence.writeGlobal(id, document),
    writeProject: async (projectId, document, titleHistories) => await persistence.writeProject(projectId, document, titleHistories),
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("beta", "C:/projects/beta"), projectOption("alpha", "C:/projects/alpha")],
      rootPath: "C:/projects",
    }),
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", projectId === "alpha" ? [source] : [target], { complete: true });
      return [];
    },
    storageRoot: root,
    threadStateStore: gatedPersistence,
  });
  const opening = Promise.all([controller.readProject(fixtureProjectIds.beta), controller.readProject(fixtureProjectIds.alpha)]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["beta"])).freshness === "fresh", "Target did not reconcile first.");
  releaseSourceRead();
  await opening;
  await waitFor(async () => {
    const entry = (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.find((candidate) => candidate.entryKind === "thread");
    return entry?.entryKind === "thread" && !entry.metadata.snoozed;
  }, "Persisted dependency did not wake after its source project loaded.");
  const stored = await persistence.readProject("alpha") as { records: Array<{ snoozedUntil?: unknown }> };
  assert.equal(stored.records[0]?.snoozedUntil, null);
  await controller.dispose();
  await temporary.dispose();
});

test("provider completion auto-completes subagents while top-level turns still need an explicit status", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-lifecycle-");
  const root = temporary.path;
  const working = (threadId: string): Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> => ({
    activityAt: 1, entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse(`${threadId}-turn`) }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false }, title: threadId,
  });
  const child: WorkbenchThreadSidebarEntry = {
    activityAt: 1, createdAt: 1, cwd: root, directSubagentIndex: 0, entryKind: "subagent", identity: { harness: "codex", threadId: fixtureThreadIds["child"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["child-turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    name: "Child", parentThreadId: fixtureThreadIds["parent"], pinned: false, profileId: "default", profileName: "Default", projectId: fixtureProjectIds["project"], title: "Child", updatedAt: 1,
  };
  const parent: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = { ...working("parent"), lifecycle: { kind: "completed", reason: "providerInactive", settled: true } };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [parent, working("top"), child], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lifecycleOf = (snapshot: Awaited<ReturnType<typeof controller.getSnapshot>>, threadId: string) => {
    const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === threadId);
    return entry?.entryKind === "draft" ? null : entry?.lifecycle.kind;
  };
  assert.equal(lifecycleOf(await controller.getSnapshot(fixtureProjectIds["project"]), "parent"), "working");
  await controller.observeLifecycle("codex", fixtureThreadIds["child"], { kind: "turnCompleted", status: "completed", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("child-turn") });
  await controller.observeLifecycle("codex", fixtureThreadIds["top"], { kind: "turnCompleted", status: "completed", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("top-turn") });
  const snapshot = await controller.getSnapshot(fixtureProjectIds["project"]);
  assert.equal(lifecycleOf(snapshot, "child"), "completed");
  assert.equal(lifecycleOf(snapshot, "top"), "needsAttention");
  assert.equal(lifecycleOf(snapshot, "parent"), "completed");
  await controller.dispose();
});

test("restoring a terminal thread persists across provider reconciliation", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-restore-");
  const root = temporary.path;
  const persistence = testPersistence(root);
  let publications = 0;
  const terminal: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["terminal"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: true, snoozed: false },
    title: "Terminal",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    onProject: () => { publications += 1; },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [terminal], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.readProject(fixtureProjectIds["project"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  publications = 0;
  const writeChanges = persistence.writeChanges.bind(persistence);
  let writes = 0;
  persistence.writeChanges = async (projectId, changes) => {
    writes += 1;
    await writeChanges(projectId, changes);
  };
  const responses = await Promise.all(Array.from({ length: 10 }, () => controller.handleRequest("observer", {
    identity: terminal.identity,
    method: "workbench/thread-state/restore",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  })));
  assert.equal(writes, 1);
  assert.equal(publications, 1);
  assert.equal(new Set(responses.map((response) => (response as { result?: { revision?: number } }).result?.revision ?? null)).size, 1);
  const restored = (await controller.getSnapshot(fixtureProjectIds["project"])).entries[0];
  assert.equal(restored?.entryKind === "thread" ? restored.lifecycle.settled : null, false);
  assert.equal(restored?.entryKind === "thread" ? restored.metadata.pinned : null, true);
  await controller.refresh(fixtureProjectIds["project"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reconciled = (await controller.getSnapshot(fixtureProjectIds["project"])).entries[0];
  assert.equal(reconciled?.entryKind === "thread" ? reconciled.lifecycle.settled : null, false);
  await controller.dispose();
});

test("manual status persists, restores settled threads, and rejects provider-owned lifecycles", async () => {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-thread-manual-attention-");
  const root = temporary.path;
  const published: WorkbenchThreadSidebarSnapshot[] = [];
  let insideGitArcTransition = false;
  let gitArcTransitions = 0;
  let terminalHasGitArc = false;
  let terminalGitArcResolved = false;
  const terminal: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1,
    entryKind: "thread",
    identity: { harness: "codex", threadId: fixtureThreadIds["terminal"] },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
    metadata: { archived: false, pinned: true, snoozed: true },
    title: "Terminal",
  };
  const pending: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...terminal,
    identity: { harness: "codex", threadId: fixtureThreadIds["pending"] },
    lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: "request", settled: false, turnId: fixtureTurnIds["turn"] },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Pending",
  };
  const working: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    ...terminal,
    identity: { harness: "codex", threadId: fixtureThreadIds["working"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Working",
  };
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    hasGitArcBlockingSettlement: async (_projectId, _harness, threadId) => {
      assert.equal(insideGitArcTransition, true);
      return terminalHasGitArc && !terminalGitArcResolved && threadId === "terminal";
    },
    onProject: snapshot => { published.push(snapshot); },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [terminal, pending, working], { complete: true });
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
  await controller.readProject(fixtureProjectIds["project"]);
  await controller.refresh(fixtureProjectIds["project"]);
  const settledSameStatus = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), status: "completed",
  });
  assert.equal("result" in settledSameStatus ? (settledSameStatus.result as { accepted?: boolean }).accepted : false, true);
  let entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, terminal.lifecycle);
  assert.deepEqual(entry?.entryKind === "thread" ? entry.metadata : null, terminal.metadata);
  const marked = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), status: "needsAttention",
  });
  assert.equal("result" in marked ? (marked.result as { accepted?: boolean }).accepted : false, true);
  entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  assert.deepEqual(entry?.entryKind === "thread" ? entry.metadata : null, { ...terminal.metadata, snoozed: false });
  await controller.refresh(fixtureProjectIds["project"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  const settledAttention = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  assert.equal("result" in settledAttention ? (settledAttention.result as { accepted?: boolean }).accepted : false, true);
  entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "completed", reason: "userCompleted", settled: true });
  assert.deepEqual(entry?.entryKind === "thread" ? entry.metadata : null, { ...terminal.metadata, snoozed: false });
  const lastPublished = published.at(-1);
  const publishedEntry = lastPublished && "entries" in lastPublished
    ? lastPublished.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal")
    : null;
  assert.deepEqual(publishedEntry?.entryKind === "thread" ? publishedEntry.lifecycle : null, { kind: "completed", reason: "userCompleted", settled: true });
  await controller.refresh(fixtureProjectIds["project"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "completed", reason: "userCompleted", settled: true });
  const rejected = await controller.handleRequest("observer", {
    identity: pending.identity, method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), status: "completed",
  });
  assert.equal("result" in rejected ? (rejected.result as { accepted?: boolean }).accepted : true, false);
  const pendingAfter = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "pending");
  assert.deepEqual(pendingAfter?.entryKind === "thread" ? pendingAfter.lifecycle : null, pending.lifecycle);
  const pendingSettleRejected = await controller.handleRequest("observer", {
    identity: pending.identity, method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  assert.equal("result" in pendingSettleRejected ? (pendingSettleRejected.result as { accepted?: boolean }).accepted : true, false);
  const pendingAfterSettle = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "pending");
  assert.deepEqual(pendingAfterSettle?.entryKind === "thread" ? pendingAfterSettle.lifecycle : null, pending.lifecycle);
  const workingRejected = await controller.handleRequest("observer", {
    identity: working.identity, method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), status: "stopped",
  });
  assert.equal("result" in workingRejected ? (workingRejected.result as { accepted?: boolean }).accepted : true, false);
  const workingAfter = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "working");
  assert.deepEqual(workingAfter?.entryKind === "thread" ? workingAfter.lifecycle : null, working.lifecycle);
  const sameStatus = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), status: "needsAttention",
  });
  assert.equal("result" in sameStatus ? (sameStatus.result as { accepted?: boolean }).accepted : false, true);
  entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "needsAttention", reason: "noActiveTurn", settled: false });
  terminalHasGitArc = true;
  terminalGitArcResolved = true;
  const resolvedSettle = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  assert.equal("result" in resolvedSettle ? (resolvedSettle.result as { accepted?: boolean }).accepted : false, true);
  await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/status/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), status: "needsAttention",
  });
  terminalGitArcResolved = false;
  const claimedSettle = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  assert.equal("result" in claimedSettle ? (claimedSettle.result as { accepted?: boolean }).accepted : true, false);
  terminalGitArcResolved = true;
  const proposedSettle = await controller.handleRequest("observer", {
    identity: terminal.identity, method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  assert.equal("result" in proposedSettle ? (proposedSettle.result as { accepted?: boolean }).accepted : false, true);
  assert.equal(gitArcTransitions, 5);
  entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "terminal");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.lifecycle : null, { kind: "completed", reason: "userCompleted", settled: true });
  await controller.dispose();
  await temporary.dispose();
});
