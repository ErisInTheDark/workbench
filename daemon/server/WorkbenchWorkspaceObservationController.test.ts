/* No production exports. Protect independent observations, generation fencing and retained failure facts. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { NativeThreadIdSchema, ProjectIdSchema, ThreadReferenceSchema, WorkbenchThreadIdSchema, type ProjectId } from "workbench-shared/workbench/identity";
import type { DaemonWorkspaceObservation, DaemonWorkspaceQuery } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadIdentityRecord } from "./database/thread-identity/workbench-thread-identity-types";
import WorkbenchWorkspaceObservationController from "./WorkbenchWorkspaceObservationController";

type Client = { id: string };
type Owners = ConstructorParameters<typeof WorkbenchWorkspaceObservationController<Client>>[0];
const a = ProjectIdSchema.parse("a");
const b = ProjectIdSchema.parse("b");
const threadId = WorkbenchThreadIdSchema.parse("10000000-0000-4000-8000-000000000001");
const sidebar = (projectId: ProjectId, revision = 1): WorkbenchThreadSidebarSnapshot => ({
  projectId, revision, entries: [], freshness: "fresh", error: null, displayOrder: {},
});

function fixture(context: TestContext, overrides: Partial<Owners> = {}) {
  const updates: Array<{ client: Client; value: DaemonWorkspaceObservation }> = [];
  const listeners = new Set<() => void>();
  let projectChanged: (id: ProjectId) => void = () => {};
  let identityChanged: (id: typeof threadId) => void = () => {};
  const warnings: string[] = [];
  const owners: Owners = {
    reload: { read: () => ({ dirtyScopes: [], pendingScopes: [], error: null }), subscribe: () => () => {} },
    catalogue: { getFacts: () => ({ revision: 0, phase: "pending", failure: null, catalogue: null, locations: null }),
      subscribe: () => () => {} },
    identities: { findThread: () => null, resolve: async () => null,
      subscribe: listener => { identityChanged = listener; return () => {}; } },
    threads: {
      peekProject: () => null, readProject: async projectId => sidebar(projectId),
      peekProjectSummary: () => null, getProjectThreadSummary: async () => { throw new Error("Unexpected summary read."); },
      readWorkspaceThread: async () => { throw new Error("Unexpected thread read."); },
      subscribeProjects: listener => { projectChanged = listener; return () => {}; },
    },
    projects: { getCurrentUpdate: () => null, observe: () => () => {} },
    publish: (client, value) => { updates.push({ client, value }); for (const listener of [...listeners]) listener(); },
    warn: message => warnings.push(message), cooperate: async () => {},
    ...overrides,
  };
  const owner = new WorkbenchWorkspaceObservationController(owners);
  context.after(() => owner.dispose());
  return { owner, owners, updates, warnings,
    projectChanged: (projectId: ProjectId) => projectChanged(projectId),
    identityChanged: () => identityChanged(threadId),
    observe: (query: DaemonWorkspaceQuery, id = randomUUID(), generation = 1, connectionId = "connection") =>
      owner.observe({ id: connectionId }, connectionId, { subscriptionId: id, generation, query }),
    wait: (predicate: (value: DaemonWorkspaceObservation) => boolean) => new Promise<DaemonWorkspaceObservation>(resolve => {
      const changed = () => {
        const latest = updates.find(update => predicate(update.value));
        if (!latest) return;
        listeners.delete(changed); resolve(latest.value);
      };
      listeners.add(changed); changed();
    }),
  };
}

test("one held project read does not block a different caller's selected project", async context => {
  const f = fixture(context);
  const held = Promise.withResolvers<WorkbenchThreadSidebarSnapshot>();
  const entered = Promise.withResolvers<void>();
  f.owners.threads.readProject = async projectId => {
    if (projectId === a) { entered.resolve(); return held.promise; }
    return sidebar(projectId);
  };
  const first = f.observe({ kind: "projectThreads", projectIds: [a] }, randomUUID(), 1, "first");
  assert.equal(first.phase, "pending");
  await entered.promise;
  const second = f.observe({ kind: "projectThreads", projectIds: [b] }, randomUUID(), 1, "second");
  await f.wait(value => value.subscriptionId === second.subscriptionId && value.phase === "current");
  assert.equal(f.updates.some(update => update.value.subscriptionId === first.subscriptionId && update.value.phase === "current"), false);
  f.owner.disconnect("second");
  held.resolve(sidebar(a));
  await f.wait(value => value.subscriptionId === first.subscriptionId && value.phase === "current");
  assert.equal(f.owner.captureInterests().length, 1);
});

test("replacing an observation fences its pending result and old releases cannot close the replacement", async context => {
  const f = fixture(context);
  const held = Promise.withResolvers<WorkbenchThreadSidebarSnapshot>();
  const entered = Promise.withResolvers<void>();
  f.owners.threads.readProject = async projectId => {
    if (projectId === a) { entered.resolve(); return held.promise; }
    return sidebar(projectId);
  };
  const id = randomUUID();
  f.observe({ kind: "projectThreads", projectIds: [a] }, id);
  await entered.promise;
  f.observe({ kind: "projectThreads", projectIds: [b] }, id, 2);
  f.owner.release("connection", { subscriptionId: id, generation: 1 });
  await f.wait(value => value.generation === 2 && value.phase === "current");
  held.resolve(sidebar(a));
  await held.promise;
  assert.equal(f.updates.some(update => update.value.generation === 1 && update.value.phase === "current"), false);
  assert.equal(f.owner.captureInterests()[0]?.request.generation, 2);
});

test("two tree observations release only their own subscriptions", context => {
  const stops: ProjectId[] = [];
  const f = fixture(context, { projects: {
    getCurrentUpdate: () => null,
    observe: projectId => () => { stops.push(ProjectIdSchema.parse(projectId)); },
  } });
  const first = f.observe({ kind: "projectTree", projectId: a }, randomUUID(), 1, "first");
  f.observe({ kind: "projectTree", projectId: b }, randomUUID(), 1, "second");
  f.owner.release("first", { subscriptionId: first.subscriptionId, generation: first.generation });
  assert.deepEqual(stops, [a]);
  assert.equal(f.owner.captureInterests().length, 1);
  f.owner.dispose();
  assert.deepEqual(stops, [a, b]);
});

test("identity admission during a pending lookup is visible even if that lookup returns absence", async context => {
  const f = fixture(context);
  const read = Promise.withResolvers<WorkbenchThreadIdentityRecord | null>();
  let admitted: WorkbenchThreadIdentityRecord | null = null;
  f.owners.identities.findThread = () => admitted;
  f.owners.identities.resolve = () => read.promise;
  f.observe({ kind: "threadIdentity", threadId: ThreadReferenceSchema.parse(threadId) });
  admitted = { threadId, projectId: a, projectRoot: "C:/a", bindings: [{
    harness: "codex", nativeLocation: "C:/a", nativeThreadId: NativeThreadIdSchema.parse("native"),
    pending: false, turnIndex: null,
  }] };
  f.identityChanged();
  read.resolve(null);
  const value = await f.wait(value => value.kind === "threadIdentity" && value.phase === "current");
  assert.equal(value.kind === "threadIdentity" ? value.identity?.threadId : null, threadId);
});

test("a failed refresh retains previous rows and waits for a new fact instead of retrying itself", async context => {
  const f = fixture(context);
  let reads = 0;
  f.owners.threads.readProject = async projectId => {
    if (++reads > 1) throw new Error("storage unavailable");
    return sidebar(projectId);
  };
  const observation = f.observe({ kind: "projectThreads", projectIds: [a] });
  await f.wait(value => value.subscriptionId === observation.subscriptionId && value.phase === "current");
  f.projectChanged(a);
  const failed = await f.wait(value => value.subscriptionId === observation.subscriptionId && value.phase === "stale");
  assert.equal(failed.kind === "projectThreads" ? failed.projects[0]?.sidebar?.projectId : null, a);
  assert.match(failed.failure ?? "", /storage unavailable/);
  assert.equal(reads, 2);
  assert.equal(f.warnings.length, 1);
});

test("placement observation tracks settled unarchived work without publishing thread rows", async context => {
  const f = fixture(context);
  f.owners.catalogue.getFacts = () => ({
    revision: 1, phase: "current", failure: null, locations: null,
    catalogue: { data: [{ id: a, kind: "git", name: "a", rootPath: "C:/a",
      relativePath: "a", lastCommitTimeMs: null, roots: [] }], aliases: [], rootPath: "" },
  });
  const settled = {
    activityAt: 1, entryKind: "thread" as const,
    identity: { harness: "codex" as const, threadId },
    lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: true },
    metadata: { archived: false, pinned: false, snoozed: false }, title: "Settled",
  };
  let archived = false;
  f.owners.threads.readProject = async projectId => ({
    ...sidebar(projectId), entries: [{ ...settled,
      metadata: archived
        ? { archived: true as const, pinned: false as const, snoozed: false as const }
        : { archived: false as const, pinned: false as const, snoozed: false as const } }],
  });
  const observation = f.observe({ kind: "projectPlacement" });
  const first = await f.wait(value => value.subscriptionId === observation.subscriptionId
    && value.kind === "projectPlacement" && value.projects[0]?.hasUnarchivedWork === true);
  assert.equal(first.kind === "projectPlacement" ? first.projects[0]?.hasUnarchivedWork : null, true);
  archived = true;
  f.projectChanged(a);
  const next = await f.wait(value => value.subscriptionId === observation.subscriptionId
    && value.kind === "projectPlacement" && value.projects[0]?.hasUnarchivedWork === false);
  assert.equal(next.kind === "projectPlacement" ? next.projects[0]?.hasUnarchivedWork : null, false);
});

test("placement read failure retains the last usable project fact and surfaces the failure", async context => {
  const f = fixture(context);
  f.owners.catalogue.getFacts = () => ({
    revision: 1, phase: "current", failure: null, locations: null,
    catalogue: { data: [{ id: a, kind: "git", name: "a", rootPath: "C:/a",
      relativePath: "a", lastCommitTimeMs: null, roots: [] }], aliases: [], rootPath: "" },
  });
  let reads = 0;
  f.owners.threads.readProject = async projectId => {
    if (++reads > 1) throw new Error("placement storage unavailable");
    return { ...sidebar(projectId), entries: [{
      activityAt: 1, entryKind: "thread",
      identity: { harness: "codex", threadId },
      lifecycle: { kind: "completed", reason: "providerInactive", settled: true },
      metadata: { archived: false, pinned: false, snoozed: false }, title: "Settled",
    }] };
  };
  const observation = f.observe({ kind: "projectPlacement" });
  await f.wait(value => value.subscriptionId === observation.subscriptionId
    && value.kind === "projectPlacement" && value.phase === "current");
  f.projectChanged(a);
  const failed = await f.wait(value => value.subscriptionId === observation.subscriptionId
    && value.kind === "projectPlacement" && value.phase === "stale");
  assert.equal(failed.kind === "projectPlacement" ? failed.projects[0]?.hasUnarchivedWork : null, true);
  assert.match(failed.failure ?? "", /placement storage unavailable/u);
  assert.equal(f.warnings.length, 1);
});

test("canonical project publications refresh an observation opened through a retained alias", async context => {
  const f = fixture(context);
  f.owners.catalogue.getFacts = () => ({ revision: 1, phase: "current", failure: null, locations: null,
    catalogue: { data: [], aliases: [{ alias: b, projectId: a }], rootPath: "" } });
  let reads = 0;
  f.owners.threads.readProject = async () => sidebar(a, ++reads);
  const observation = f.observe({ kind: "projectThreads", projectIds: [b] });
  await f.wait(value => value.subscriptionId === observation.subscriptionId && value.phase === "current");
  f.projectChanged(a);
  const next = await f.wait(value => value.kind === "projectThreads" && value.projects[0]?.sidebar?.revision === 2);
  assert.equal(next.kind === "projectThreads" ? next.projects[0]?.projectId : null, b);
  assert.equal(reads, 2);
});
