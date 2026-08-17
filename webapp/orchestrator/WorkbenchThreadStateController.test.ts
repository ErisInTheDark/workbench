/* No production exports. Tests protect observation replay, request telemetry, reconciliation, persistence mutations, and stale publication fences. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";
import type { WorkbenchProjectStateUpdate } from "../lib/workbench/project/project-state";
import type { WorkbenchThreadSidebarEntry, WorkbenchThreadStateSnapshot } from "../lib/workbench/thread/thread-state";

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
      acceptProviderSnapshot("codex", [knownEntry]);
      return [];
    },
    resolveProjectRoot: async () => root,
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
  });
  const firstOpen = controller.open("first", "project");
  const secondOpen = controller.open("second", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
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
        acceptProviderSnapshot("codex", [known]);
        return [];
      }
      staleAccept = acceptProviderSnapshot as typeof staleAccept;
      return await new Promise((resolve) => { releaseStale = () => resolve([]); });
    },
    resolveProjectRoot: async () => root,
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
      acceptProviderSnapshot("codex", []);
      return [];
    },
    resolveProjectRoot: async () => root,
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

test("accepted intent survives provider discovery lag and releases after its lifecycle advances", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-thread-accepted-"));
  const published: WorkbenchThreadSidebarEntry[] = [];
  const publishedSnapshots: WorkbenchThreadStateSnapshot[] = [];
  const controller = new WorkbenchThreadStateController({
    getProjectCatalog: projectCatalog,
    now: () => 42,
    publish: (_connectionId, snapshot) => {
      publishedSnapshots.push(snapshot);
      if (!("entries" in snapshot)) return;
      const entry = snapshot.entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
      if (entry) published.push(entry);
    },
    projectState: projectState(),
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", []);
      return [];
    },
    resolveProjectRoot: async () => root,
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
  assert.equal(entry?.activityAt, 42);
  assert.equal(published.at(-1)?.title, "First user message");
  assert.equal(publishedSnapshots.length, 1);
  assert.equal("entries" in publishedSnapshots[0]!, true);
  if ("entries" in publishedSnapshots[0]!) {
    assert.equal(publishedSnapshots[0].entries.some((candidate) => candidate.entryKind === "draft"), false);
    assert.equal(publishedSnapshots[0].entries.some((candidate) => candidate.entryKind === "thread" && candidate.identity.threadId === "provider"), true);
  }
  const stored = JSON.parse(await fs.readFile(path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment("project")}.json`), "utf8")) as { drafts: unknown[]; threads: Array<{ threadId?: string }> };
  assert.deepEqual(stored.drafts, []);
  assert.equal(stored.threads.some((candidate) => candidate.threadId === "provider"), true);
  await controller.refresh("project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const laggingEntry = (await controller.getSnapshot("project")).entries.find((candidate) => candidate.entryKind !== "draft" && candidate.identity.threadId === "provider");
  assert.equal(laggingEntry?.title, "First user message");
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
      acceptProviderSnapshot("codex", [parent, working("top"), child]);
      return [];
    },
    resolveProjectRoot: async () => root,
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
    publish: () => undefined,
    reconcileProject: async (_projectId, _signal, acceptProviderSnapshot) => {
      acceptProviderSnapshot("codex", [terminal]);
      return [];
    },
    resolveProjectRoot: async () => root,
  });
  await controller.open("observer", "project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.handleRequest("observer", {
    identity: terminal.identity,
    method: "workbench/thread-state/restore",
    projectId: "project",
  });
  const restored = (await controller.getSnapshot("project")).entries[0];
  assert.equal(restored?.entryKind === "thread" ? restored.lifecycle.settled : null, false);
  assert.equal(restored?.entryKind === "thread" ? restored.metadata.pinned : null, true);
  await controller.refresh("project");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reconciled = (await controller.getSnapshot("project")).entries[0];
  assert.equal(reconciled?.entryKind === "thread" ? reconciled.lifecycle.settled : null, false);
  await controller.dispose();
});
