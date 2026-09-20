/*
 * Exports: none. Tests protect headless thread ownership, mutations, durability, and publication fences.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchThreadStateControllerOwner, { type WorkbenchThreadStateControllerOptions } from "./WorkbenchThreadStateController";
import type { WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";
import type { WorkbenchComposerProfile, WorkbenchComposerProfileTargetSelection, WorkbenchReloadDirtSnapshot } from "workbench-shared/types";
import { getProjectQualifiedThreadDisplayKey, getThreadDisplayFolderKey, getThreadDisplayThreadKey } from "workbench-shared/workbench/thread/thread-display-layout";
import { getWorkbenchHomeFolderKey } from "workbench-shared/workbench/thread/home-thread-display-order";
import { projectWorkbenchThreadDisplaySection } from "workbench-shared/workbench/thread/thread-display-order";
import { WorkbenchPinnedThreadContextResultSchema, WorkbenchThreadObservationResultSchema, WorkbenchThreadStateMutationResultSchema, WorkbenchThreadTitleMutationResultSchema, type WorkbenchThreadSidebarEntry, type WorkbenchThreadSidebarSnapshot, type WorkbenchThreadStateSnapshot } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import WorkbenchThreadStateStore, { type WorkbenchStoredThreadTitleHistory, type WorkbenchThreadStateGlobalDocumentId, type WorkbenchThreadStatePersistence } from "./WorkbenchThreadStateStore";
import { normalizeProviderSidebarEntry as normalizeSidebarEntry } from "./WorkbenchThreadStateFeature";
import { parseProjectDocument } from "./database/thread-state/workbench-thread-state-document-source";

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

type TestControllerOptions = Omit<WorkbenchThreadStateControllerOptions, "resolveProjectId" | "hasLiveGitArcClaims" | "resolveGitArc" | "resolveGitArcPlan" | "runGitArcReadTransition" | "threadStateStore">
  & Partial<Pick<WorkbenchThreadStateControllerOptions, "resolveProjectId" | "hasLiveGitArcClaims" | "resolveGitArc" | "resolveGitArcPlan" | "runGitArcReadTransition" | "threadStateStore">>
  & {
    storageRoot: string;
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

  async writeGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object) {
    this.globals.set(id, structuredClone(document));
  }

  async writeProject(projectId: string, document: object, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]) {
    this.projects.set(ProjectIdSchema.parse(projectId), structuredClone(document));
    if (titleHistories) this.titleHistories.set(projectId, structuredClone([...titleHistories]));
  }
}

const testPersistenceByRoot = new Map<string, MemoryThreadStatePersistence>();

test("retained project requests share one observation and move drafts between canonical owners", async () => {
  const persistence = new MemoryThreadStatePersistence();
  const source = testProjectIds.project;
  const destination = testProjectIds.other;
  const observations: string[] = [];
  const stopped: string[] = [];
  const controller = new WorkbenchThreadStateController({
    storageRoot: "canonical-project-requests", threadStateStore: persistence,
    resolveProjectId: id => {
      if (id === fixtureProjectIds.alpha || id === source) return source;
      if (id === fixtureProjectIds.beta || id === destination) return destination;
      throw new Error("Project ownership has not been admitted.");
    },
    getProjectCatalog: () => ({ data: [projectOption(source, "C:/source"), projectOption(destination, "C:/destination")], rootPath: "C:/" }),
    projectState: { ...projectState(), observe: id => { observations.push(id); return () => { stopped.push(id); }; } },
    publish: () => undefined, reconcileProject: async () => [],
  });
  const draft = {
    draftId: "eb83014c-5b6c-4bd0-963b-27c5641a0f93", projectId: fixtureProjectIds.alpha, prompt: "retain me",
    profileId: null, attachments: [],
    composerSettings: { harness: "codex", agentPath: null, agentSource: null, model: "model", reasoningEffort: null, serviceTier: null },
    clientUpdatedAt: 1, createdAt: 1, updatedAt: 1,
  };
  try {
    const opened = await controller.open("connection", fixtureProjectIds.alpha, 1);
    assert.equal(opened.projectId, source);
    const before = structuredClone({ projects: persistence.projects, globals: persistence.globals });
    for (const id of ["remote:/example.test/source", "remote://example.test/unknown"]) {
      await assert.rejects(controller.open("connection", ProjectIdSchema.parse(id)), /project/i);
      await assert.rejects(controller.handleRequest("connection", {
        method: "workbench/thread-state/open", projectId: id, version: 2,
      }), /project/i);
    }
    assert.deepEqual(stopped, []);
    assert.deepEqual({ projects: persistence.projects, globals: persistence.globals }, before);
    await controller.handleRequest("connection", { method: "workbench/thread-state/draft/upsert", projectId: fixtureProjectIds.alpha, draft });
    assert.equal((await controller.getSnapshot(source)).entries.length, 1);
    assert.ok(!persistence.projects.has(fixtureProjectIds.alpha));
    await controller.handleRequest("connection", {
      method: "workbench/thread-state/draft/move", sourceProjectId: fixtureProjectIds.alpha,
      destinationProjectId: fixtureProjectIds.beta, draftId: draft.draftId,
    });
    assert.equal((await controller.getSnapshot(source)).entries.length, 0);
    const moved = (await controller.getSnapshot(destination)).entries[0];
    assert.ok(moved?.entryKind === "draft");
    assert.equal(moved.draft.projectId, destination);
    assert.equal(moved.draft.prompt, draft.prompt);
    await controller.close("connection", fixtureProjectIds.alpha);
    assert.deepEqual(observations, [source]);
    assert.deepEqual(stopped, [source]);
  } finally { await controller.dispose(); }
});

test("thread mutations do not replace their project document", async () => {
  const persistence = new MemoryThreadStatePersistence();
  const controller = new WorkbenchThreadStateController({
    storageRoot: "isolated-thread-writes", threadStateStore: persistence,
    getProjectCatalog: () => ({ data: [], rootPath: "" }), projectState: projectState(),
    publish: () => undefined, reconcileProject: async () => [],
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
    await controller.open("isolated-viewer", fixtureProjectIds["project"], 4);
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
    getProjectCatalog: () => ({ data: [], rootPath: "" }), projectState: projectState(),
    publish: () => undefined, reconcileProject: async () => [],
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
    getProjectCatalog: () => ({ data: [], rootPath: "" }), projectState: projectState(),
    publish: () => undefined, reconcileProject: async () => [],
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
    getProjectCatalog: () => ({ data: [], rootPath: "" }), projectState: projectState(),
    publish: () => undefined,
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
      projectState: projectState(), publish() {}, reconcileProject: async () => [],
    });
    const reading = scope === "project" ? controller.getSnapshot(fixtureProjectIds["project"]) : controller.openGlobal("viewer", 6);
    const rejected = assert.rejects(reading, /retired/);
    await entered;
    const disposing = controller.dispose();
    await disposing;
    release(null);
    await rejected;
    assert.equal(persistence.projects.size + persistence.globals.size, 0);
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
    projectState: projectState(), publish() {}, reconcileProject: async () => [],
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

test("first title observation is durable before a rename and keeps its timestamp after restart", async () => {
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
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
  };
  const first = new WorkbenchThreadStateController(options);
  try {
    await first.getSnapshot(fixtureProjectIds["project"]);
    const observed = normalizeProviderSidebarEntry("codex", { id: identity.threadId, name: "existing title", updatedAt: 1 });
    assert.ok(observed && observed.entryKind !== "draft");
    await first.ensureProviderEntry(fixtureProjectIds["project"], observed);
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
    projectState: projectState(),
    publish: () => undefined,
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
    await controller.open("viewer", fixtureProjectIds["project"]);
    const originalProvider = normalizeProviderSidebarEntry("codex", { id: provider.identity.threadId, name: provider.title, updatedAt: 1 });
    assert.ok(originalProvider && originalProvider.entryKind !== "draft");
    await controller.ensureProviderEntry(fixtureProjectIds["project"], originalProvider);
    now = 20;
    const renamed = await controller.handleRequest("viewer", {
      method: "workbench/thread-state/title/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: provider.identity, title: "renamed",
    });
    assert.equal(renamed.error, undefined);
    const snapshot = () => controller.getSnapshot(fixtureProjectIds["project"]);
    const renamedEntry = (await snapshot()).entries[0]!;
    assert.deepEqual("previousTitles" in renamedEntry ? renamedEntry.previousTitles : undefined, [{ title: "original", usedAt: 10 }]);
    now = 30;
    await controller.observeTitle("codex", fixtureThreadIds["history-thread"], "renamed");
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
    const denied = await controller.handleRequest("stranger", dismissRequest);
    assert.ok(denied.error);
    const dismissed = await controller.handleRequest("viewer", dismissRequest);
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
    projectState: projectState(),
    publish: () => undefined,
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
      resolveProjectId: id => id,
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
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(projectId),
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
  const publications: WorkbenchThreadStateSnapshot[] = [];
  const observed: WorkbenchThreadSidebarEntry[] = [];
  const controller = new WorkbenchThreadStateController({
    storageRoot: "immediate-incremental-settlement", projectState: projectState(),
    getProjectCatalog: () => ({ data: [projectOption("project", "C:/project")], rootPath: "C:/" }),
    publish: (_connection, snapshot) => publications.push(snapshot),
    reconcileProject: async () => { entered(); await gate; return []; },
  });
  let refreshing: Promise<WorkbenchThreadSidebarSnapshot> | null = null;
  try {
    for (const threadId of ["changed", "unrelated"]) await controller.ensureProviderEntry(fixtureProjectIds["project"], {
      entryKind: "thread", identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) }, activityAt: 1, title: threadId,
      metadata: { archived: false, pinned: false, snoozed: false },
      lifecycle: { kind: "completed", reason: "userCompleted", settled: false },
    });
    await controller.open("viewer", fixtureProjectIds["project"], 5);
    refreshing = controller.refresh(fixtureProjectIds["project"]);
    await started;
    publications.length = 0;
    await controller.handleRequest("viewer", {
      method: "workbench/thread-state/settle", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("changed") },
    });
    const delta = publications.find(snapshot => "updateKind" in snapshot && snapshot.updateKind === "threadStateDelta");
    assert.ok(delta && "upserts" in delta);
    assert.equal(delta.upserts.length, 1);
    assert.equal(delta.upserts[0]?.entryKind !== "draft" && delta.upserts[0]?.lifecycle.settled, true);
    publications.length = 0;
    await controller.handleRequest("viewer", {
      method: "workbench/thread-state/priority/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), sourceKey: "codex:unrelated", priority: "pinned",
    });
    const priority = publications.find(snapshot => "updateKind" in snapshot && snapshot.updateKind === "threadStateDelta");
    assert.ok(priority && "upserts" in priority);
    assert.equal(priority.upserts.length, 1);
    assert.equal(priority.upserts[0]?.entryKind === "thread" && priority.upserts[0].metadata.pinned, true);
    publications.length = 0;
    await controller.setTitle(fixtureProjectIds["project"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("unrelated"), "visible title");
    const title = publications.find(snapshot => "updateKind" in snapshot && snapshot.updateKind === "threadStateDelta");
    assert.ok(title && "upserts" in title);
    assert.equal(title.upserts[0]?.title, "visible title");
    await controller.close("viewer", fixtureProjectIds["project"]);
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

test("a pinned thread observation receives full live state without observing its project sidebar", async () => {
  const identity = { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("foreign-thread") };
  const provider: Extract<WorkbenchThreadSidebarEntry, { entryKind: "thread" }> = {
    activityAt: 1, entryKind: "thread", title: "Foreign", identity,
    metadata: { archived: false, pinned: true, snoozed: false },
    lifecycle: { kind: "needsAttention", reason: "noActiveTurn", settled: false },
  };
  const publications: Array<{ connectionId: string; snapshot: WorkbenchThreadStateSnapshot }> = [];
  const controller = new WorkbenchThreadStateController({
    storageRoot: "foreign-thread-observation",
    threadStateStore: new MemoryThreadStatePersistence(),
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/alpha"), projectOption("beta", "C:/beta")],
      rootPath: "C:/",
    }),
    projectState: projectState(),
    publish: (connectionId, snapshot) => publications.push({ connectionId, snapshot }),
    reconcileProject: async () => [{ harness: "opencode", message: "Unrelated provider is unavailable." }],
  });
  try {
    await controller.ensureProviderEntry(fixtureProjectIds["beta"], provider);
    await controller.refresh(fixtureProjectIds["beta"]);
    await controller.open("viewer", fixtureProjectIds["alpha"], 4);
    const subscriptionId = "4f603f09-c04c-43ab-b879-6fbe4133b94a";
    const response = await controller.handleRequest("viewer", {
      method: "workbench/thread-state/observe",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
      subscriptionId,
      target: { kind: "provider", ...identity },
      version: 1,
    });
    assert.ok("result" in response, "a visible foreign pin must acquire its own observation");
    const result = WorkbenchThreadObservationResultSchema.parse(response.result);
    assert.equal(result.observation.entries[0]?.entryKind, "thread");
    assert.equal(result.observation.error, null);
    assert.equal(result.observation.freshness, "fresh");
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
    const observationUpdates = () => publications.flatMap(({ connectionId, snapshot }) => (
      connectionId === "viewer" && "updateKind" in snapshot && snapshot.updateKind === "threadObservation"
        ? [snapshot]
        : []
    ));
    const pending = observationUpdates().at(-1)?.entries[0];
    assert.ok(pending && pending.entryKind !== "draft");
    assert.deepEqual(pending.pendingQuestionnaire, question);
    await controller.observeLifecycle("codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId), { kind: "inputResolved", requestKey: question.requestKey });
    const cleared = observationUpdates().at(-1)?.entries[0];
    assert.ok(cleared && cleared.entryKind !== "draft");
    assert.equal(cleared.pendingQuestionnaire, null);
    await controller.handleRequest("viewer", { method: "workbench/thread-state/release", subscriptionId });
    const count = observationUpdates().length;
    await controller.setTitle(fixtureProjectIds["beta"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(identity.threadId), "Updated");
    assert.equal(observationUpdates().length, count);
  } finally {
    await controller.dispose();
  }
});

async function readProjectState<T extends object>(storageRoot: string, projectId: string) {
  return await testPersistence(storageRoot).readProject(projectId) as T;
}

test("accepted questionnaire response returns its thread to working", async () => {
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
    threadStateStore: new MemoryThreadStatePersistence(),
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => {},
    reconcileProject: async (_project, _signal, accept) => {
      await accept("codex", [provider], { complete: true });
      return [];
    },
  });
  try {
    await controller.open("observer", fixtureProjectIds["project"]);
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
      getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => {},
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
      await controller.open("observer", fixtureProjectIds["project"]);
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
    getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => {},
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
    getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => {},
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
    getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => {},
    reconcileProject: async (_project, _signal, accept) => { await accept("codex", [provider], { complete: true }); return []; },
    interruptQuestionnaire: async () => {
      interrupts++;
      await controller.applyLifecycle(fixtureProjectIds["project"], "codex", provider.identity.threadId, { kind: "turnCompleted", status: "interrupted", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") });
      return true;
    },
  });
  try {
    await controller.open("observer", fixtureProjectIds["project"]);
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

test("UI subscribers share headless observation and warm snapshots without owning reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-state-"));
  const published: Array<{ connectionId: string; revision: number }> = [];
  let reconciliations = 0;
  let projectObservationStarts = 0;
  let projectObservationStops = 0;
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
    projectState: projectState({ observe: () => { projectObservationStarts += 1; return () => { projectObservationStops += 1; }; } }),
    publish: (connectionId, snapshot) => {
      if (!("updateKind" in snapshot)) published.push({ connectionId, revision: snapshot.revision });
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      reconciliations += 1;
      await acceptProviderSnapshot("codex", [knownEntry], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  const first = await controller.open("a", fixtureProjectIds["project"]);
  assert.equal(first.sidebar.freshness, "loading");
  await waitFor(() => reconciliations === 1, "Initial reconciliation did not start.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = await controller.open("b", fixtureProjectIds["project"]);
  assert.equal(second.sidebar.freshness, "fresh", second.sidebar.error ?? "Reconciliation did not become fresh.");
  assert.equal(second.sidebar.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "known"), true);
  assert.deepEqual(second.catalog, projectCatalog());
  assert.equal(reconciliations, 1);
  assert.equal(projectObservationStarts, 1);
  await controller.refresh(fixtureProjectIds["project"]);
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
  await controller.open("c", fixtureProjectIds["project"]);
  assert.equal(projectObservationStarts, 2);
  await controller.close("c");
  assert.equal(projectObservationStops, 2);
  await controller.dispose();
  assert.equal(projectObservationStops, 2);
});

test("global pinned folders import project layout, accept mixed-project members, broadcast, and remove snoozed members", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-global-pinned-layout-"));
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
  const published: Array<{ connectionId: string; snapshot: WorkbenchThreadStateSnapshot }> = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({ data: projects.map((id) => projectOption(id, path.join(root, id))), rootPath: root }),
    projectState: projectState(),
    publish: (connectionId, snapshot) => { published.push({ connectionId, snapshot }); },
    reconcileProject: async () => [],
    storageRoot: root,
  });
  const opened = await controller.open("observer-a", fixtureProjectIds["project-a"], 3);
  await controller.open("observer-b", fixtureProjectIds["project-b"], 3);
  await waitFor(
    () => published.some(({ snapshot }) => "updateKind" in snapshot && snapshot.updateKind === "projectThreadSummary" && snapshot.summary.projectId === "project-b"),
    "The cold project summary did not hydrate.",
  );
  assert.equal(opened.pinnedThreadLayout.displayOrder.folders?.[0]?.title, "Everywhere");
  const keyA = getProjectQualifiedThreadDisplayKey(fixtureProjectIds["project-a"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:a"));
  const keyB = getProjectQualifiedThreadDisplayKey(fixtureProjectIds["project-b"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:b"));
  const movedAcrossPriority = await controller.handleRequest("observer-a", {
    beforeKey: getThreadDisplayFolderKey(folderId),
    destinationFolderId: null,
    method: "workbench/thread-state/pinned-display-order/move",
    sourceKey: keyB,
  });
  assert.equal("result" in movedAcrossPriority ? WorkbenchThreadStateMutationResultSchema.parse(movedAcrossPriority.result).accepted : false, true);
  const movedProject = await controller.getSnapshot(fixtureProjectIds["project-b"]);
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
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("b") },
    method: "workbench/thread-state/snooze/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project-b"),
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
  await controller.open("observer", fixtureProjectIds["project"], 3);
  const writeChanges = persistence.writeChanges.bind(persistence);
  persistence.writeChanges = async () => {
    persistence.writeChanges = writeChanges;
    throw new Error("Project persistence unavailable.");
  };

  await assert.rejects(
    controller.handleRequest("observer", {
      beforeKey: null,
      destinationFolderId: null,
      method: "workbench/thread-state/pinned-display-order/move",
      sourceKey: getProjectQualifiedThreadDisplayKey(fixtureProjectIds["project"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:thread")),
    }),
    /Project persistence unavailable/u,
  );
  const entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread");
  assert.deepEqual(entry?.entryKind === "thread" ? entry.metadata : null, { archived: false, pinned: false, snoozed: true });
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("project, pinned, and home thread state persist authoritatively in SQLite across controller restart", async () => {
  const projectId = testProjectIds.project;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-sqlite-authority-"));
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
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
    threadStateStore: store,
  });
  let controller = createController();
  try {
    await controller.openGlobal("global", 6);
    await waitFor(async () => (await controller.getSnapshot(projectId)).entries.length === 2, "Provider entries did not reconcile.");
    const alphaKey = getProjectQualifiedThreadDisplayKey(projectId, getThreadDisplayThreadKey("codex", alpha!.threadId));
    const betaKey = getProjectQualifiedThreadDisplayKey(projectId, getThreadDisplayThreadKey("codex", beta!.threadId));
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

    const projectDocument = await store.readProject(projectId) as { records?: unknown[] } | null;
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
    await assert.rejects(readController.getSnapshot(fixtureProjectIds["project"]), /sqlite read unavailable/u);
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
    await writeController.open("observer", fixtureProjectIds["project"], 4);
    writeStore.writeChanges = async () => { throw new Error("sqlite write unavailable"); };
    const draftId = "00000000-0000-4000-8000-000000000302";
    await assert.rejects(writeController.handleRequest("observer", {
      draft: {
        agent: null, attachments: [], clientUpdatedAt: 1, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 1,
        draftId, harness: "codex", model: null, profileId: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), prompt: "Rejected draft",
        reasoningEffort: null, serviceTier: null, updatedAt: 1,
      },
      method: "workbench/thread-state/draft/upsert",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
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

  const opened = await controller.open("observer", fixtureProjectIds["project"], 3);

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
    identity: { harness: "codex", threadId: fixtureThreadIds["waiting-thread"] },
    lifecycle: { agent: { agentStatus: "working", turnId: fixtureTurnIds["turn"] }, kind: "working", reason: "acceptedIntent", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title: "Waiting thread",
  };
  let reconciled = false;
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [entry], { complete: true });
      reconciled = true;
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
  await waitFor(() => reconciled, "Waiting-state provider thread was not reconciled.");
  controller.setThreadWaitState("codex", "waiting-thread", ["subagent_wait"]);
  const waiting = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread");
  assert.equal(waiting?.entryKind === "thread" ? waiting.waitingFor : null, "subagents");
  await controller.observeTitle("codex", fixtureThreadIds["waiting-thread"], "Still waiting");
  const stored = await readProjectState<object>(root, "project");
  assert.equal(JSON.stringify(stored).includes("waitingFor"), false);
  controller.setThreadWaitState("codex", "waiting-thread", []);
  const cleared = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "thread");
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
        : { agent: { agentStatus: "working" as const, turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false as const };
      await acceptProviderSnapshot("codex", [{
        activityAt: reconciliation,
        entryKind: "thread",
        identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(`${projectId}-thread`) },
        lifecycle,
        metadata: { archived: false, pinned: false, snoozed: false },
        title: projectId,
      }], { complete: true });
      return [];
    },
    storageRoot: root,
  });

  await controller.open("warm-alpha", fixtureProjectIds["alpha"], 2);
  await controller.open("warm-beta", fixtureProjectIds["beta"], 2);
  await waitFor(() => reconcileCounts.get("alpha") === 1 && reconcileCounts.get("beta") === 1, "Project summaries did not warm.");
  await new Promise<void>((resolve) => setImmediate(resolve));

  const v2 = await controller.open("v2", fixtureProjectIds["alpha"], 2);
  assert.equal("projectThreads" in v2, false);
  const v3 = await controller.open("v3", fixtureProjectIds["alpha"], 3);
  assert.deepEqual(v3.projectThreads.projects.map(({ counts, lastThreadUpdateAt, projectId, unsettledThreads }) => ({
    lastThreadUpdateAt,
    projectId,
    threadStatuses: unsettledThreads.map(({ status }) => status),
    working: counts.working,
  })), [
    { lastThreadUpdateAt: 1, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"), threadStatuses: ["working"], working: 1 },
    { lastThreadUpdateAt: 1, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"), threadStatuses: ["working"], working: 1 },
  ]);

  publications.length = 0;
  await controller.refresh(fixtureProjectIds["beta"]);
  await waitFor(() => publications.some(({ snapshot }) => "updateKind" in snapshot
    && snapshot.updateKind === "projectThreadSummary" && snapshot.summary.projectId === "beta"
    && snapshot.summary.counts.needsAttentionActive === 1), "Refreshed project summary was not published.");
  const summaryPublications = publications.filter((publication) => "updateKind" in publication.snapshot
    && publication.snapshot.updateKind === "projectThreadSummary");
  assert.equal(summaryPublications.length > 0, true);
  assert.equal(summaryPublications.every(({ connectionId }) => connectionId === "v3"), true);
  const update = summaryPublications.at(-1)?.snapshot;
  assert.deepEqual(update && "updateKind" in update && update.updateKind === "projectThreadSummary"
    ? {
      lastThreadUpdateAt: update.summary.lastThreadUpdateAt,
      needsAttention: update.summary.counts.needsAttentionActive,
      threadStatuses: update.summary.unsettledThreads.map(({ status }) => status),
    }
    : null, {
    lastThreadUpdateAt: 1,
    needsAttention: 1,
    threadStatuses: ["needsAttentionActive"],
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

  const opened = await controller.open("progressive", fixtureProjectIds["alpha"], 3);
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

test("an observed project represents a missing thread as an empty observation", async () => {
  const controller = new WorkbenchThreadStateController({
    storageRoot: "missing-thread-observation",
    threadStateStore: new MemoryThreadStatePersistence(),
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/alpha")],
      rootPath: "C:/",
    }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
  });
  try {
    await controller.open("viewer", fixtureProjectIds["alpha"], 4);
    const expectedFreshness = (await controller.getSnapshot(fixtureProjectIds["alpha"])).freshness;
    const response = await controller.handleRequest("viewer", {
      method: "workbench/thread-state/observe",
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
      subscriptionId: "709113f5-ca7c-4ba0-b26b-10bd31af8648",
      target: {
        harness: "codex",
        kind: "provider",
        threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("missing-thread"),
      },
      version: 1,
    });
    assert.ok("result" in response);
    const result = WorkbenchThreadObservationResultSchema.parse(response.result);
    assert.deepEqual(result.observation.entries, []);
    assert.equal(result.observation.freshness, expectedFreshness);
  } finally {
    await controller.dispose();
  }
});

test("pinned context admits only an unsnoozed root and its direct subagents, then fences foreign mutations to that observation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-pinned-context-"));
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
    projectState: projectState(),
    publish: () => undefined,
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
  await controller.open("owner-loader", fixtureProjectIds["owner"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["owner"])).entries.length === 2, "Pinned owner did not load.");
  await controller.open("viewer", fixtureProjectIds["viewed"]);

  const observed = await controller.handleRequest("viewer", {
    method: "workbench/thread-state/observe", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"), version: 1,
    subscriptionId: "8a1f2219-334a-48ce-a016-bd3c595402ee",
    target: { harness: "opencode", kind: "subagent", parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child-thread") },
  });
  assert.deepEqual(WorkbenchThreadObservationResultSchema.parse(observed.result).observation.entries.map(entry =>
    entry.entryKind === "draft" ? entry.draft.draftId : entry.identity.threadId), ["root-thread", "child-thread"]);
  const readingDoesNotGrantMutation = await controller.handleRequest("viewer", {
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread") },
    method: "workbench/thread-state/title/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"), title: "Must not rename from child observation",
  });
  assert.equal(readingDoesNotGrantMutation.error?.code, "invalidProjectObservation");

  const opened = await controller.handleRequest("viewer", {
    method: "workbench/thread-state/pin/open",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    target: { harness: "opencode", kind: "subagent", parentThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread"), threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child-thread") },
  });
  const openedContext = WorkbenchPinnedThreadContextResultSchema.parse(opened.result);
  assert.deepEqual(openedContext.context
    ? openedContext.context.entries.map((entry) => entry.entryKind === "draft" ? entry.draft.draftId : entry.identity.threadId)
    : null, ["root-thread", "child-thread"]);

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
  await controller.open("new-viewer", fixtureProjectIds["viewed"]);
  const snoozed = await controller.handleRequest("new-viewer", {
    method: "workbench/thread-state/pin/open",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    target: { kind: "provider", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread") },
  });
  assert.equal(WorkbenchPinnedThreadContextResultSchema.parse(snoozed.result).context, null);
  await assert.rejects(controller.handleRequest("new-viewer", {
    method: "workbench/thread-state/observe", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"), version: 1,
    subscriptionId: "bb7efb3d-4670-4198-a8ab-8926782c4ed3",
    target: { kind: "provider", harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread") },
  }), /requestedProject=owner.*observedProject=viewed.*target=provider:root-thread.*missing, snoozed, or not pinned/iu);

  await controller.close("viewer");
  await controller.open("viewer", fixtureProjectIds["viewed"]);
  const rejectedAfterReopen = await controller.handleRequest("viewer", {
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("root-thread") },
    method: "workbench/thread-state/title/set",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("owner"),
    title: "Must not rename",
  });
  assert.equal(rejectedAfterReopen.error?.code, "invalidProjectObservation");
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("provider omission retains saved threads through partial, complete, and reopened snapshots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-progressive-"));
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
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [oldEntry], { complete: true });
      initialInstalled.resolve();
      return [];
    },
    storageRoot: root,
  });
  try {
    await controller.open("observer", fixtureProjectIds["project"]);
    await initialInstalled.promise;
    await controller.dispose();
    const refreshing = new WorkbenchThreadStateController({
      getProjectCatalog: projectCatalog,
      projectState: projectState(),
      publish: () => undefined,
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
      await refreshing.open("observer", fixtureProjectIds["project"]);
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
      getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => undefined,
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
    await fs.rm(root, { force: true, recursive: true });
  }
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
  const firstOpen = controller.open("first", fixtureProjectIds["project"]);
  const secondOpen = controller.open("second", fixtureProjectIds["project"]);
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
  const opened = await controller.open("observer", fixtureProjectIds["project"]);
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
      draftId, harness: "codex", model: null, profileId: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), prompt: "Persisted draft",
      reasoningEffort: null, serviceTier: null, updatedAt: 1,
    },
    method: "workbench/thread-state/draft/upsert",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
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
    const legacy = await controller.open("legacy-project", fixtureProjectIds["project"], 3);
    const current = await controller.open("current-project", fixtureProjectIds["project"], 4);
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
    projectState: projectState(),
    publish: () => undefined,
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

  const opened = await controller.open("observer", fixtureProjectIds["project"]);
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
  await fs.rm(root, { force: true, recursive: true });
});

test("draft saves update defaults atomically without defaults rewriting other drafts", async (context) => {
  const persistence = new MemoryThreadStatePersistence();
  const options = {
    getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => undefined,
    reconcileProject: async () => [], storageRoot: "draft-defaults", threadStateStore: persistence,
  };
  const controller = new WorkbenchThreadStateController(options);
  context.after(() => controller.dispose());
  const projectId = fixtureProjectIds.project;
  const defaults = { kind: "new-thread" as const, projectId };
  const firstId = fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111");
  const secondId = fixtureIdentitySchemas.DraftIdSchema.parse("22222222-2222-4222-8222-222222222222");
  const draft = {
    draftId: firstId, projectId, profileId: null, composerSettings: { ...EMPTY_CODEX_SETTINGS, model: "first" },
    prompt: "draft", attachments: [], clientUpdatedAt: 2, createdAt: 1, updatedAt: 2,
  };
  const save = async (value: typeof draft) => {
    const response = await controller.handleRequest("observer", {
      method: "workbench/thread-state/draft/upsert", projectId, draft: value,
    });
    assert.equal(response.error, undefined, "draft save request");
    return response;
  };
  await save(draft);
  await save({ ...draft, draftId: secondId, composerSettings: { ...draft.composerSettings, model: "second" } });
  const firstSlot = { kind: "draft" as const, projectId, draftId: firstId, harness: "codex" as const };
  const secondSlot = { ...firstSlot, draftId: secondId };
  await controller.setComposerProfileTarget(defaults, { kind: "custom", settings: { ...draft.composerSettings, model: "new-default" } });
  assert.equal((await controller.readComposerProfileTarget(firstSlot))?.settings.model, "first");
  assert.equal((await controller.readComposerProfileTarget(secondSlot))?.settings.model, "second");
  await save({ ...draft, clientUpdatedAt: 1, prompt: "stale" });
  assert.equal((await controller.readComposerProfileTarget(defaults))?.settings.model, "new-default");
  await save({ ...draft, clientUpdatedAt: 3, prompt: "accepted autosave" });
  assert.equal((await controller.readComposerProfileTarget(defaults))?.settings.model, "first");
  const write = persistence.writeChanges.bind(persistence);
  persistence.writeChanges = async () => { throw new Error("Draft disk failure"); };
  await assert.rejects(save({ ...draft, clientUpdatedAt: 4, composerSettings: { ...draft.composerSettings, model: "unsaved" } }), /Draft disk failure/);
  assert.equal((await controller.readComposerProfileTarget(defaults))?.settings.model, "first");
  assert.equal((await controller.readComposerProfileTarget(firstSlot))?.settings.model, "first");
  persistence.writeChanges = write;
  await controller.dispose();
  const reopened = new WorkbenchThreadStateController(options);
  context.after(() => reopened.dispose());
  assert.equal((await reopened.readComposerProfileTarget(defaults))?.settings.model, "first");
  assert.equal((await reopened.readComposerProfileTarget(secondSlot))?.settings.model, "second");
});

test("Custom draft provider changes update defaults and reject writes addressed to the old provider", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-draft-provider-"));
  const projectId = fixtureProjectIds.project;
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse("11111111-1111-4111-8111-111111111111");
  const settings = { harness: "codex" as const, model: "codex-model", agentPath: null, agentSource: null, reasoningEffort: null, serviceTier: null };
  const selection = { kind: "custom" as const, settings };
  await seedProjectState(root, "project", {
    drafts: [{ draftId, projectId, profileId: null, composerSettings: settings, prompt: "Keep this", attachments: [], clientUpdatedAt: 1, createdAt: 1, updatedAt: 1 }],
    records: [], version: 3, newThreadProfile: selection,
  });
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog, projectState: projectState(), publish() {},
    reconcileProject: async () => [], storageRoot: root,
  });
  try {
    const oldSlot = { kind: "draft" as const, projectId, draftId, harness: "codex" as const };
    const next = { kind: "custom" as const, settings: { ...settings, harness: "copilot" as const, model: "copilot-model" } };
    assert.equal(await controller.setComposerProfileTarget(oldSlot, next), true);
    assert.deepEqual(await controller.readComposerProfileTarget({ ...oldSlot, harness: "copilot" }), next);
    assert.equal(await controller.setComposerProfileTarget(oldSlot, selection), false);
    assert.deepEqual(await controller.readComposerProfileTarget({ kind: "new-thread", projectId }), next);
    const entry = (await controller.getSnapshot(projectId)).entries.find(entry => entry.entryKind === "draft");
    assert.equal(entry?.entryKind === "draft" ? entry.draft.prompt : null, "Keep this");
  } finally {
    await controller.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("daemon thread state owns profile migration, draft defaults, materialization, and reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-profiles-"));
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
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async () => [],
    readComposerProfiles: async () => ({ profiles }),
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);

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

  const savedDraft = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "draft");
  assert.ok(savedDraft?.entryKind === "draft");
  await controller.handleRequest("observer", {
    method: "workbench/thread-state/draft/upsert", projectId: fixtureProjectIds["project"],
    draft: { ...savedDraft.draft, clientUpdatedAt: 3, prompt: "Autosaved draft" },
  });
  assert.deepEqual(await controller.readComposerProfileTarget({ kind: "new-thread", projectId: fixtureProjectIds["project"] }), selected);

  await controller.acceptIntent("observer", {
    draftId,
    harness: "codex",
    projectId: fixtureProjectIds["project"],
    threadId: fixtureThreadIds["materialized"],
    title: "Profile draft",
    turnId: fixtureTurnIds["turn"],
  });
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
  await controller.setComposerProfileTarget({ kind: "new-thread", projectId: fixtureProjectIds["project"] }, migrated);
  await controller.acceptIntent("observer", {
    harness: "codex", projectId: fixtureProjectIds["project"], threadId: fixtureThreadIds["materialized"], turnId: fixtureTurnIds["next-turn"],
  });
  assert.deepEqual(await controller.readComposerProfileTarget(threadSlot), selected);
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
      projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
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
    destinationProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
    draftId,
    method: "workbench/thread-state/draft/move",
    sourceProjectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
  });
  const moved = WorkbenchThreadStateMutationResultSchema.parse("result" in response ? response.result : null);
  assert.equal(moved.accepted, true);
  assert.equal((await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.some((entry) => entry.entryKind === "draft"), false);
  const destinationDraft = (await controller.getSnapshot(fixtureProjectIds["beta"])).entries.find((entry) => entry.entryKind === "draft");
  assert.deepEqual(destinationDraft?.entryKind === "draft" ? {
    agentPath: destinationDraft.draft.composerSettings.agentPath,
    model: destinationDraft.draft.composerSettings.model,
    profileId: destinationDraft.draft.profileId,
    projectId: destinationDraft.draft.projectId,
  } : null, {
    agentPath: "profile-agent.md",
    model: "gpt-profile",
    profileId: "profile-one",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta"),
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
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
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
      await acceptProviderSnapshot("codex", entriesByProject.get(projectId) ?? [], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  const controller = createController();
  const opened = await controller.openGlobal("global", 5);
  assert.equal("homeThreadDisplayOrder" in opened, true);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.length === 2, "Alpha threads were not discovered.");
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["beta"])).entries.length === 1, "Beta threads were not discovered.");

  const folderId = fixtureIdentitySchemas.FolderIdSchema.parse("00000000-0000-4000-8000-000000000202");
  const created = await controller.handleRequest("global", {
    folderId,
    method: "workbench/thread-state/display-order/folder/create",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("alpha"),
    sourceKey: "codex:a",
    title: "Alpha only",
  });
  assert.equal("result" in created && (created.result as { accepted?: boolean }).accepted, true);

  const alphaA = getProjectQualifiedThreadDisplayKey(fixtureProjectIds["alpha"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:a"));
  const alphaB = getProjectQualifiedThreadDisplayKey(fixtureProjectIds["alpha"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:b"));
  const betaC = getProjectQualifiedThreadDisplayKey(fixtureProjectIds["beta"], fixtureIdentitySchemas.ThreadDisplayKeySchema.parse("codex:c"));
  const alphaFolder = getWorkbenchHomeFolderKey(fixtureProjectIds["alpha"], folderId);
  const movedAcrossPriority = await controller.handleRequest("global", {
    beforeKey: alphaA,
    destinationFolderKey: null,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: betaC,
  });
  assert.equal("result" in movedAcrossPriority && (movedAcrossPriority.result as { accepted?: boolean }).accepted, true);
  const movedProject = await controller.getSnapshot(fixtureProjectIds["beta"]);
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
  assert.deepEqual((await controller.getSnapshot(fixtureProjectIds["alpha"])).displayOrder.folders?.[0]?.threadKeys, ["codex:a"]);

  const filled = await controller.handleRequest("global", {
    beforeKey: null,
    destinationFolderKey: alphaFolder,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: alphaB,
  });
  assert.equal("result" in filled && (filled.result as { accepted?: boolean }).accepted, true);
  assert.deepEqual((await controller.getSnapshot(fixtureProjectIds["alpha"])).displayOrder.folders?.[0]?.threadKeys, ["codex:a", "codex:b"]);

  const foreign = await controller.handleRequest("global", {
    beforeKey: null,
    destinationFolderKey: alphaFolder,
    method: "workbench/thread-state/home-display-order/move",
    section: "pinned",
    sourceKey: betaC,
  });
  assert.equal("result" in foreign && (foreign.result as { accepted?: boolean }).accepted, false);
  assert.deepEqual((await controller.getSnapshot(fixtureProjectIds["alpha"])).displayOrder.folders?.[0]?.threadKeys, ["codex:a", "codex:b"]);

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
  assert.deepEqual((await controller.getSnapshot(fixtureProjectIds["alpha"])).displayOrder.folders?.[0]?.threadKeys, ["codex:b"]);
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

  await assert.rejects(controller.open("observer", fixtureProjectIds["project"]), /without a recoverable identity/u);
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
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("legacy-thread"),
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
  await fs.rm(root, { force: true, recursive: true });
});

test("continuous settlement prunes once per durable epoch, retries failures, and resets on restore", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-git-retention-"));
  let now = 1_000;
  const pruned: Array<Array<{ harness: string; threadId: string }>> = [];
  let rejectNextPrune = false;
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
      await acceptProviderSnapshot("codex", [providerEntry], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
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
    identity: { harness: "codex", threadId: fixtureThreadIds["late"] },
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
      await acceptProviderSnapshot("codex", [lateEntry], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
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
  await controller.open("first", fixtureProjectIds["project"]);
  const late = await controller.open("late", fixtureProjectIds["project"]);
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
  await controller.open("first", fixtureProjectIds["project"]);
  await controller.open("joining", fixtureProjectIds["project"]);
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
    identity: { harness: "codex" as const, threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("known") },
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
        await acceptProviderSnapshot("codex", [known], { complete: true });
        return [];
      }
      staleAccept = acceptProviderSnapshot as typeof staleAccept;
      return await new Promise((resolve) => { releaseStale = () => resolve([]); });
    },
    storageRoot: root,
  });
  await controller.open("first", fixtureProjectIds["project"]);
  await waitFor(() => reconciliationCount === 1, "Initial reconciliation did not start.");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await controller.getSnapshot(fixtureProjectIds["project"])).freshness, "fresh");

  await controller.refresh(fixtureProjectIds["project"]);
  assert.equal(reconciliationCount, 2);
  assert.equal((await controller.getSnapshot(fixtureProjectIds["project"])).freshness, "fresh");
  await controller.close("first");
  const reopened = await controller.open("reopened", fixtureProjectIds["project"]);
  assert.equal(reopened.sidebar.freshness, "fresh");
  assert.equal(reopened.sidebar.entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "known"), true);
  assert.equal(reconciliationCount, 2);

  staleAccept?.("codex", [{ ...known, identity: { harness: "codex", threadId: fixtureThreadIds["stale"] }, title: "Stale" }], { complete: true });
  releaseStale();
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).entries.some((entry) => entry.entryKind !== "draft" && entry.identity.threadId === "stale"), "Headless reconciliation did not publish after the UI reconnected.");
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
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("secret-thread-id") },
    method: "workbench/thread-state/intent/accept",
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
  await original.open("observer", fixtureProjectIds["project"]);
  const value = {
    agent: null, attachments: [], clientUpdatedAt: 1, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 1,
    draftId, harness: "codex" as const, model: null, profileId: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), prompt: "Priority draft",
    reasoningEffort: null, serviceTier: null, updatedAt: 1,
  };
  await original.handleRequest("observer", { draft: value, method: "workbench/thread-state/draft/upsert", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") });
  await original.handleRequest("observer", { draftId, method: "workbench/thread-state/draft/pin/set", pinned: true, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") });
  await original.handleRequest("observer", { draftId, method: "workbench/thread-state/draft/snooze/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), snoozed: true });
  await original.handleRequest("observer", { draft: { ...value, clientUpdatedAt: 2, prompt: "Updated priority draft", updatedAt: 2 }, method: "workbench/thread-state/draft/upsert", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") });
  let entry = (await original.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind === "draft" && candidate.draft.draftId === draftId);
  assert.deepEqual(entry?.entryKind === "draft" ? entry.metadata : null, { archived: false, pinned: true, snoozed: true });
  await original.dispose();

  const reopened = createController();
  const opened = await reopened.open("reopened", fixtureProjectIds["project"]);
  entry = opened.sidebar.entries.find((candidate) => candidate.entryKind === "draft" && candidate.draft.draftId === draftId);
  assert.equal(entry?.entryKind === "draft" ? entry.draft.prompt : null, "Updated priority draft");
  assert.deepEqual(entry?.entryKind === "draft" ? entry.metadata : null, { archived: false, pinned: true, snoozed: true });
  const stored = await readProjectState<{ drafts: Array<{ pinned?: boolean; snoozed?: boolean }>; version?: number }>(root, "project");
  assert.equal(stored.version, 4);
  assert.deepEqual(stored.drafts.map(({ pinned, snoozed }) => ({ pinned, snoozed })), [{ pinned: true, snoozed: true }]);
  await reopened.dispose();
});

test("accepted intent survives provider discovery lag and remains visible after its lifecycle advances", async () => {
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
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const draftId = "00000000-0000-4000-8000-000000000001";
  await controller.handleRequest("observer", {
    draft: {
      agent: null, attachments: [], clientUpdatedAt: 2, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 1,
      draftId, harness: "codex", model: null, profileId: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
      prompt: "First user message", reasoningEffort: null, serviceTier: null, updatedAt: 2,
    },
    method: "workbench/thread-state/draft/upsert",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  await controller.handleRequest("observer", { draftId, method: "workbench/thread-state/draft/pin/set", pinned: true, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") });
  await controller.handleRequest("observer", { draftId, method: "workbench/thread-state/draft/snooze/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), snoozed: true });
  publishedSnapshots.length = 0;
  const response = await controller.handleRequest("observer", {
    draftId,
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("provider") },
    method: "workbench/thread-state/intent/accept",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    title: "First user message",
    turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn"),
  });
  assert.equal("error" in response, false);
  const entry = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
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
  const turnStartUpdate = publishedSnapshots.at(-1);
  assert.equal(turnStartUpdate && "orderAt" in turnStartUpdate ? turnStartUpdate.orderAt : null, 55);
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
    identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId) },
    lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
    metadata: { archived: false, pinned: false, snoozed: false },
    title,
  });

  await controller.open("observer", fixtureProjectIds["project"]);
  await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry("neutral", "New thread"));
  await controller.acceptIntent("observer", {
    harness: "codex", projectId: fixtureProjectIds["project"], threadId: fixtureThreadIds["neutral"], title: "First user message", turnId: fixtureTurnIds["neutral-turn"],
  });
  await controller.ensureProviderEntry(fixtureProjectIds["project"], providerEntry("named", "Meaningful provider title"));
  await controller.acceptIntent("observer", {
    harness: "codex", projectId: fixtureProjectIds["project"], threadId: fixtureThreadIds["named"], title: "Different user message", turnId: fixtureTurnIds["named-turn"],
  });

  const snapshot = await controller.getSnapshot(fixtureProjectIds["project"]);
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
    projectState: projectState(),
    publish: (_connectionId, snapshot) => {
      if ("entries" in snapshot && snapshot.entries.length === 2) discovered = true;
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [accepted, pending], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
  await waitFor(() => discovered, "Snoozed threads were not discovered.");

  await controller.acceptIntent("observer", {
    harness: "codex",
    projectId: fixtureProjectIds["project"],
    threadId: fixtureThreadIds["accepted"],
    title: "Accepted",
    turnId: fixtureTurnIds["new-turn"],
  });
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
  await fs.rm(root, { force: true, recursive: true });
});

test("replayed questionnaire lifecycle does not invent fresh thread activity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-questionnaire-replay-"));
  const publications: WorkbenchThreadStateSnapshot[] = [];
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
    projectState: projectState(),
    publish: (_connectionId, snapshot) => { publications.push(snapshot); },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [providerEntry], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
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
  await fs.rm(root, { force: true, recursive: true });
});

test("inactive providers release stale questionnaire ownership without changing terminal semantics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-inactive-questionnaire-"));
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
    projectState: projectState(),
    publish: (_connectionId, snapshot) => {
      if ("entries" in snapshot) publishedEntries = snapshot.entries;
      if (!("updateKind" in snapshot) && snapshot.freshness === "fresh") freshRevision = snapshot.revision;
    },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
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
  await fs.rm(root, { force: true, recursive: true });
});

test("proper questionnaires and late-response history survive controller restarts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-questionnaire-"));
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
    projectState: projectState(),
    publish: () => undefined,
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
  await first.open("first", fixtureProjectIds["project"]);
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
  await second.open("second", fixtureProjectIds["project"]);
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
  await third.open("third", fixtureProjectIds["project"]);
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
  await fourth.open("fourth", fixtureProjectIds["project"]);
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
  await fs.rm(root, { force: true, recursive: true });
});

test("wake waits for every unsnoozed row to become settlement-ready, then wakes only the highest projected root snoozed thread", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-one-wake-"));
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
    snoozed("a", 3), snoozed("b", 2), snoozed("c", 1),
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
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  const controller = createController();
  await controller.open("observer", fixtureProjectIds["project"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).entries.length === providerEntries.length, "Threads were not discovered.");
  const reordered = await controller.handleRequest("observer", {
    beforeKey: "codex:a",
    destinationFolderId: null,
    method: "workbench/thread-state/display-order/move",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    section: "snoozed",
    sourceKey: "codex:c",
  });
  assert.equal("result" in reordered && (reordered.result as { accepted?: boolean }).accepted, true);
  const folderId = "00000000-0000-4000-8000-000000000042";
  const foldered = await controller.handleRequest("observer", {
    folderId,
    method: "workbench/thread-state/display-order/folder/create",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    sourceKey: "codex:c",
    title: "Keep asleep",
  });
  assert.equal("result" in foldered && (foldered.result as { accepted?: boolean }).accepted, true);
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
  await reopened.open("reopened", fixtureProjectIds["project"]);
  await waitFor(async () => (await reopened.getSnapshot(fixtureProjectIds["project"])).entries.length === providerEntries.length, "Reopened threads were not discovered.");
  const reopenedSnapshot = await reopened.getSnapshot(fixtureProjectIds["project"]);
  const reopenedSnoozeState = new Map(reopenedSnapshot.entries.flatMap((entry) => entry.entryKind === "thread" ? [[entry.identity.threadId, entry.metadata.snoozed] as const] : []));
  assert.equal(reopenedSnoozeState.get(fixtureThreadIds["c"]), true);
  assert.equal(reopenedSnoozeState.get(fixtureThreadIds["a"]), false);
  assert.equal(reopenedSnoozeState.get(fixtureThreadIds["b"]), true);
  assert.deepEqual(reopenedSnapshot.displayOrder.folders?.[0]?.threadKeys, ["codex:c"]);
  await reopened.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("thread folders persist across restart and reconcile members that leave their section", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-folders-"));
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
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", providerEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  const folderId = "00000000-0000-4000-8000-000000000030";
  const controller = createController();
  await controller.open("observer", fixtureProjectIds["project"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const created = await controller.handleRequest("observer", { folderId, method: "workbench/thread-state/display-order/folder/create", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), sourceKey: "codex:a", title: "New folder" });
  assert.equal("result" in created && (created.result as { accepted?: boolean }).accepted, true);
  const renamed = await controller.handleRequest("observer", { folderId, method: "workbench/thread-state/display-order/folder/title/set", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), title: "Important" });
  assert.equal("result" in renamed && (renamed.result as { accepted?: boolean }).accepted, true);
  const filled = await controller.handleRequest("observer", { beforeKey: null, destinationFolderId: folderId, method: "workbench/thread-state/display-order/move", projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), section: "pinned", sourceKey: "codex:b" });
  assert.equal("result" in filled && (filled.result as { accepted?: boolean }).accepted, true);
  const draftId = fixtureIdentitySchemas.DraftIdSchema.parse("00000000-0000-4000-8000-000000000031");
  const drafted = await controller.handleRequest("observer", {
    draft: {
      agent: null, attachments: [], clientUpdatedAt: 3, composerSettings: EMPTY_CODEX_SETTINGS, createdAt: 3,
      draftId, harness: "codex", model: null, profileId: null, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"), prompt: "folder draft",
      reasoningEffort: null, serviceTier: null, updatedAt: 3,
    },
    folderId,
    method: "workbench/thread-state/draft/upsert",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
  });
  assert.equal("result" in drafted && (drafted.result as { accepted?: boolean }).accepted, true);
  await controller.dispose();

  const reopened = createController();
  await reopened.open("reopened", fixtureProjectIds["project"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const restoredFolder = (await reopened.getSnapshot(fixtureProjectIds["project"])).displayOrder?.folders?.[0];
  assert.equal(restoredFolder?.title, "Important");
  assert.deepEqual(restoredFolder?.threadKeys, [`draft:${draftId}`, "codex:a", "codex:b"]);
  const restoredDraft = (await reopened.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "draft");
  assert.deepEqual(restoredDraft?.entryKind === "draft" ? restoredDraft.metadata : null, { archived: false, pinned: true, snoozed: false });
  await reopened.acceptIntent("reopened", { draftId, harness: "codex", projectId: fixtureProjectIds["project"], threadId: fixtureThreadIds["materialized"], title: "Materialized", turnId: fixtureTurnIds["turn"] });
  assert.deepEqual((await reopened.getSnapshot(fixtureProjectIds["project"])).displayOrder?.folders?.[0]?.threadKeys, ["codex:materialized", "codex:a", "codex:b"]);
  await reopened.handleRequest("reopened", { identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("b") }, method: "workbench/thread-state/pin/set", pinned: false, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") });
  assert.deepEqual((await reopened.getSnapshot(fixtureProjectIds["project"])).displayOrder?.folders?.[0]?.threadKeys, ["codex:materialized", "codex:a"]);
  await reopened.handleRequest("reopened", { identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("a") }, method: "workbench/thread-state/pin/set", pinned: false, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") });
  assert.deepEqual((await reopened.getSnapshot(fixtureProjectIds["project"])).displayOrder?.folders?.[0]?.threadKeys, ["codex:materialized"]);
  await reopened.handleRequest("reopened", { identity: { harness: "codex", threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("materialized") }, method: "workbench/thread-state/pin/set", pinned: false, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project") });
  assert.deepEqual((await reopened.getSnapshot(fixtureProjectIds["project"])).displayOrder, {});
  await reopened.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("profile-less threads use defaults and reads cannot overtake a failed profile save", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-profile-admission-"));
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
    getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => undefined,
    reconcileProject: async () => [], storageRoot: root, threadStateStore: persistence,
  });
  context.after(async () => { release(); await controller.dispose(); await fs.rm(root, { recursive: true, force: true }); });
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-profile-restart-"));
  const persistence = new MemoryThreadStatePersistence();
  let profiles: WorkbenchComposerProfile[] = [{
    ...EMPTY_CODEX_SETTINGS, id: "named", name: "Named", model: "original",
    createdAt: 1, updatedAt: 1, scope: { kind: "global" },
  }];
  const create = () => new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => undefined,
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
  context.after(async () => { await restarted.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const effective = await restarted.readComposerProfileTarget(slot);
  assert.equal(effective?.settings.model, "latest");
  const candidate = (await restarted.prepareComposerProfileTarget(slot)).selection;
  assert.equal(candidate.settings.agentPath, "library:agents/lily.md");
  assert.equal(candidate.settings.model, "latest");
  assert.deepEqual(await restarted.readComposerProfileTarget(slot), candidate);
  profiles = [];
  assert.deepEqual((await restarted.prepareComposerProfileTarget(slot)).selection, { kind: "custom", settings: selection.settings });
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
  await assert.rejects(restarted.prepareComposerProfileTarget(childSlot), /harness does not match/u);
});

test("profile admission publishes only accepted candidates and orders later edits without blocking lifecycle writes", async (context) => {
  const persistence = new MemoryThreadStatePersistence();
  const usage: Array<{ id: string; at: number }> = [];
  const original = { kind: "profile" as const, profileId: "named", settings: { ...EMPTY_CODEX_SETTINGS, model: "old" } };
  const latest = { ...original.settings, model: "new" };
  const controller = new WorkbenchThreadStateController({
    storageRoot: "profile-admission", threadStateStore: persistence,
    getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => undefined,
    reconcileProject: async () => [],
    now: () => 1234,
    recordComposerProfileUsage: async (id: string, at: number) => { usage.push({ id, at }); },
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
  const accepted = await controller.withComposerProfileAdmission(slot, async () => ({ accepted: true, result: "sent" }), signal);
  assert.equal(accepted.profilePersistenceError, null);
  assert.deepEqual(usage, [{ id: "named", at: 1234 }]);
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
    getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => undefined,
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
    getProjectCatalog: projectCatalog, projectState: projectState(), publish: () => undefined,
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

test("drag priority and folder drops update one project-owned state atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-drag-priority-"));
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
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [source, target], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
  await waitFor(async () => (await controller.getSnapshot(fixtureProjectIds["project"])).freshness === "fresh", "Project did not reconcile.");

  const crossPriorityMove = await controller.handleRequest("observer", {
    beforeKey: "codex:target",
    destinationFolderId: null,
    method: "workbench/thread-state/display-order/move",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    section: "snoozed",
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

  const folderId = "00000000-0000-4000-8000-000000000077";
  const folderDrop = await controller.handleRequest("observer", {
    destinationFolderId: null,
    folderId,
    method: "workbench/thread-state/display-order/folder/drop",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    section: "snoozed",
    sourceKey: "codex:source",
    targetKey: "codex:target",
  });
  assert.equal("result" in folderDrop && (folderDrop.result as { accepted?: boolean }).accepted, true);
  snapshot = await controller.getSnapshot(fixtureProjectIds["project"]);
  moved = snapshot.entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "source");
  assert.deepEqual(moved?.entryKind === "thread" ? moved.metadata : null, { archived: false, pinned: true, snoozed: true });
  assert.deepEqual(snapshot.displayOrder.folders?.[0]?.threadKeys, ["codex:source", "codex:target"]);

  await controller.handleRequest("observer", {
    method: "workbench/thread-state/priority/set",
    priority: "main",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("project"),
    sourceKey: "codex:source",
  });
  moved = (await controller.getSnapshot(fixtureProjectIds["project"])).entries.find((entry) => entry.entryKind === "thread" && entry.identity.threadId === "source");
  assert.deepEqual(moved?.entryKind === "thread" ? moved.metadata : null, { archived: false, pinned: false, snoozed: false });
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("cross-project dependent snooze waits for completion and the final live claim", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-dependent-snooze-"));
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
    projectState: projectState(),
    publish: () => undefined,
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
  await controller.openGlobal("observer", 6);
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
  assert.deepEqual(stored.records[0]?.snoozedUntil, { identity: target.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") });

  targetArc = null;
  await controller.refreshGitArcState(fixtureProjectIds["beta"], "codex", fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("target"));
  sourceEntry = (await controller.getSnapshot(fixtureProjectIds["alpha"])).entries.find((entry) => entry.entryKind === "thread");
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
    projectState: projectState(),
    publish: () => undefined,
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
  await controller.openGlobal("observer", 6);
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
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: () => ({
      data: [projectOption("alpha", "C:/projects/alpha"), projectOption("beta", "C:/projects/beta")],
      rootPath: "C:/projects",
    }),
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", projectId === "alpha" ? [source, ordinary, active] : betaEntries, { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.openGlobal("observer", 6);
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
    { identity: targetB.identity, projectId: fixtureIdentitySchemas.ProjectIdSchema.parse("beta") },
  );

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
  await controller.dispose();
  await fs.rm(root, { force: true, recursive: true });
});

test("restart reevaluates a persisted dependency when its ready target loaded first", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-dependent-snooze-restart-"));
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
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", projectId === "alpha" ? [source] : [target], { complete: true });
      return [];
    },
    storageRoot: root,
    threadStateStore: gatedPersistence,
  });
  const opening = controller.openGlobal("observer", 6);
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
  await fs.rm(root, { force: true, recursive: true });
});

test("provider completion auto-completes subagents while top-level turns still need an explicit status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-lifecycle-"));
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
    projectState: projectState(),
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [parent, working("top"), child], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-restore-"));
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
    projectState: projectState(),
    publish: (_connectionId, snapshot) => { if ("entries" in snapshot) publications += 1; },
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      await acceptProviderSnapshot("codex", [terminal], { complete: true });
      return [];
    },
    storageRoot: root,
  });
  await controller.open("observer", fixtureProjectIds["project"]);
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-manual-attention-"));
  const published: WorkbenchThreadStateSnapshot[] = [];
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
    hasLiveGitArcClaims: async (_projectId, _harness, threadId) => {
      assert.equal(insideGitArcTransition, true);
      return terminalHasGitArc && !terminalGitArcResolved && threadId === "terminal";
    },
    projectState: projectState(),
    publish: (_connectionId, snapshot) => published.push(snapshot),
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
  await controller.open("observer", fixtureProjectIds["project"]);
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
  await fs.rm(root, { force: true, recursive: true });
});
