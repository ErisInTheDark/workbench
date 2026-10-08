/* No production exports. Protect independent app queries, coalescing, daemon stats relay and caller disposal. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "../../../shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkbenchClientStateResponse } from "workbench-shared/state/workbench-client-state";
import type { WorkspaceObservation, WorkspaceObservationDelta } from "workbench-shared/workbench/workspace/workspace-observation";
import { DaemonIdSchema, ProjectIdSchema, ProjectIdentityKeySchema, ThreadReferenceSchema, WorkbenchThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchPresentationRepository from "../state/WorkbenchPresentationRepository";
import WorkbenchPresentationController from "../state/WorkbenchPresentationController";
import WorkbenchDaemonSources from "./WorkbenchDaemonSources";
import WorkbenchWorkspaceController from "./WorkbenchWorkspaceController";
import WorkbenchWorkspaceThreads from "./WorkbenchWorkspaceThreads";
import WorkbenchWorkspaceRequestController from "./WorkbenchWorkspaceRequestController";
import { WorkspaceCommandSchema } from "workbench-shared/workbench/workspace/workspace-commands";
import { DEFAULT_THREAD_AUTO_COMPACT_SETTINGS } from "workbench-shared/workbench/settings/thread-auto-compact";

test("git summary routes through the observed folder's daemon and rejects missing or unobserved scope", async context => {
  const daemonId = DaemonIdSchema.parse(randomUUID());
  const location = { daemonId, projectId: ProjectIdSchema.parse("observed-folder") };
  const calls: Array<{ method: string; params: object }> = [];
  const summary = { repositories: [{ rootId: "root", label: "folder", dirty: true }], errors: [] };
  const source = {
    available: true,
    request: async (method: string, params: object) => { calls.push({ method, params }); return summary; },
  };
  const f = await fixture(context, { get: id => id === daemonId ? source : undefined });
  const snapshot = f.workspace.getSnapshot();
  context.mock.method(f.workspace, "getSnapshot", () => ({
    ...snapshot,
    observedProjects: [{
      identityKey: ProjectIdentityKeySchema.parse("local:///repo/folder"), registrationFailure: null,
      locations: [{ location, hostname: "remote", project: {
        id: location.projectId, kind: "git" as const, name: "folder", relativePath: "folder",
        rootPath: "/repo/folder", roots: [], lastCommitTimeMs: null,
      } }],
    }],
  }));
  assert.deepEqual(await f.owner.command(WorkspaceCommandSchema.parse({
    method: "git/working-tree/summary", scope: { kind: "folder", location },
    params: { projectId: "wrong-project" },
  })), summary);
  assert.deepEqual(calls, [{ method: "git/working-tree/summary", params: { projectId: location.projectId } }]);
  await assert.rejects(f.owner.command(WorkspaceCommandSchema.parse({
    method: "git/working-tree/summary",
    scope: { kind: "folder", location: { ...location, projectId: ProjectIdSchema.parse("not-observed") } },
    params: { projectId: location.projectId },
  })), /not observed/);
  await assert.rejects(async () => f.owner.command(WorkspaceCommandSchema.parse({
    method: "git/working-tree/summary", params: { projectId: location.projectId },
  })));
  assert.equal(calls.length, 1);
});

test("Git arc thread routing canonicalises the owner without forwarding project identity", async context => {
  const daemonId = DaemonIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse("owner-project");
  const requestedThreadId = ThreadReferenceSchema.parse("provider-thread");
  const threadId = WorkbenchThreadIdSchema.parse(randomUUID());
  const calls: Array<{ method: string; params: object }> = [];
  const result = { conflictedPaths: [], phase: "stashed", stashedPaths: ["src/changed.ts"] };
  const owner = {
    phase: "current" as const,
    identity: { harness: "codex" as const, projectId, threadId },
    location: { daemonId, projectId },
    logicalProjectId: null,
  };
  const f = await fixture(context, undefined, {
    withThread: async (id, action) => {
      assert.equal(id, requestedThreadId);
      return await action({
        request: async (method: string, params: object) => {
          calls.push({ method, params });
          return result;
        },
      } as never, owner);
    },
  });

  assert.deepEqual(await f.owner.command(WorkspaceCommandSchema.parse({
    method: "git/arc/stash",
    params: { cwd: "C:/repo", harness: "codex", threadId: requestedThreadId },
  })), result);
  assert.deepEqual(calls, [{
    method: "git/arc/stash",
    params: { cwd: "C:/repo", harness: "codex", threadId },
  }]);
});

test("daemon compaction settings route to the selected installation without a project", async context => {
  const daemonId = DaemonIdSchema.parse(randomUUID());
  const calls: Array<{ method: string; params: object }> = [];
  const source = {
    available: true,
    request: async (method: string, params: { settings?: object }) => {
      calls.push({ method, params });
      return { settings: { ...DEFAULT_THREAD_AUTO_COMPACT_SETTINGS, ...params.settings } };
    },
  };
  const f = await fixture(context, { get: id => id === daemonId ? source : undefined });
  const scope = { kind: "installation", daemonId };
  assert.deepEqual(await f.owner.command(WorkspaceCommandSchema.parse({
    method: "thread-auto-compact/read", scope, params: {},
  })), { settings: DEFAULT_THREAD_AUTO_COMPACT_SETTINGS });
  const patch = { enabled: false, idleMinutes: 40 };
  assert.deepEqual(await f.owner.command(WorkspaceCommandSchema.parse({
    method: "thread-auto-compact/update", scope, params: { settings: patch },
  })), { settings: { ...DEFAULT_THREAD_AUTO_COMPACT_SETTINGS, ...patch } });
  assert.deepEqual(calls, [
    { method: "thread-auto-compact/read", params: {} },
    { method: "thread-auto-compact/update", params: { settings: patch } },
  ]);
});

function state(revision: number): WorkbenchClientStateResponse {
  return { daemonRegistrationId: "registration", revision, kind: "snapshot", oldestAvailableRevision: 0,
    rows: {
      composerDraftAttachments: [], composerDrafts: [], fileDrafts: [], globalPreferences: [],
      modelPreferences: [], modelGroupDisclosures: [], lastLaunchTarget: [], logicalProjectPreferences: [],
      projectExpandedDirectories: [], projectPreferences: [],
      projectSidebarFolders: [], projectSidebarPreferences: [], questionnaireDraftAnswers: [],
      questionnaireDraftAttachments: [], questionnaireDraftSelections: [], questionnaireDrafts: [],
    } };
}

/** `daemons` replaces daemon lookup for the request owner only, standing in for connected sources. */
async function fixture(
  context: TestContext,
  daemons?: { get(daemonId: string): object | undefined; attached?: object },
  owners?: Partial<Pick<WorkbenchWorkspaceThreads, "observe" | "withThread">>,
) {
  const temporary = await WorkbenchTemporaryDirectory.create("workspace-request-owner-");
  const directory = temporary.path;
  const repository = new WorkbenchPresentationRepository({ databasePath: path.join(directory, "presentation.sqlite3") });
  await repository.start();
  const presentation = new WorkbenchPresentationController(repository);
  const sources = new WorkbenchDaemonSources({ network: {
    daemonSources: () => ({ current: false, attached: null, localOrigin: null, discovery: { refreshing: true, peers: [] } }),
    canAccessPeer: () => null, subscribe: () => () => {},
  }, warn: () => {} });
  const warnings: string[] = [];
  const workspace = new WorkbenchWorkspaceController({ sources, presentation, warn: message => warnings.push(message) });
  const threads = new WorkbenchWorkspaceThreads({ sources, presentation, warn: message => warnings.push(message) });
  const changes = new Set<() => void>();
  const updates: WorkspaceObservation[] = [];
  const deltas: WorkspaceObservationDelta[] = [];
  const providerEvents: Array<{ method: string; harness: string; daemonId: string }> = [];
  const listeners = new Set<() => void>();
  let read: () => Promise<WorkbenchClientStateResponse> = async () => state(0);
  const requestSources = daemons ? Object.assign(Object.create(sources) as typeof sources, { get: daemons.get }) : sources;
  if (daemons?.attached) Object.defineProperty(requestSources, "attached", { value: daemons.attached });
  const owner = new WorkbenchWorkspaceRequestController({
    workspace, presentation,
    threads: owners ? Object.assign(Object.create(threads) as typeof threads, owners) : threads,
    sources: requestSources,
    network: { read: () => ({ kind: "network", phase: "pending", failure: null, data: null }), subscribe: () => () => {} },
    runtime: { read: () => null, subscribe: () => () => {} },
    appState: { read: () => read(), subscribe: (_id, listener) => {
      changes.add(listener); return () => { changes.delete(listener); };
    } },
    // Deltas are published after the owner records its new value; tests read that full value.
    publishDelta: delta => {
      deltas.push(delta);
      const value = (owner as unknown as { interests: Map<string, { value: WorkspaceObservation }> }).interests.get(delta.subscriptionId)?.value;
      if (value) updates.push(value);
      for (const listener of [...listeners]) listener();
    },
    publishVoice: () => {},
    publishThreadEvent: (notification, harness, daemonId) => {
      providerEvents.push({ method: notification.method, harness, daemonId });
    },
    publishTranscript: () => {},
    warn: message => warnings.push(message),
  });
  context.after(async () => {
    owner.dispose(); threads.dispose(); workspace.dispose(); sources.dispose();
    presentation.close(); await repository.close(); await temporary.dispose();
  });
  return { owner, workspace, updates, deltas, providerEvents, warnings, changes,
    read: (operation: typeof read) => { read = operation; },
    changed: () => { for (const changed of [...changes]) changed(); },
    wait: (predicate: (value: WorkspaceObservation) => boolean) => new Promise<WorkspaceObservation>(resolve => {
      const changed = () => {
        const value = updates.find(predicate);
        if (!value) return;
        listeners.delete(changed); resolve(value);
      };
      listeners.add(changed); changed();
    }),
  };
}

test("provider-wide model changes reach browsers without thread demand", async context => {
  const f = await fixture(context);
  let notify: (notification: { method: "models/updated"; params: object }, harness: "opencode") => void = () => {
    throw new Error("Provider listener was not registered.");
  };
  f.owner["observeProvider"]({
    id: "daemon",
    socket: { onNotification: (listener: typeof notify) => {
      notify = listener;
      return () => {};
    } },
  } as never);
  notify({ method: "models/updated", params: {} }, "opencode");
  assert.deepEqual(f.providerEvents, [{ method: "models/updated", harness: "opencode", daemonId: "daemon" }]);
});

test("update observations relay the local installation but expose no remote checkout update", async context => {
  const localId = DaemonIdSchema.parse(randomUUID());
  const remoteId = DaemonIdSchema.parse(randomUUID());
  const update = {
    state: "available" as const, reason: null, upstream: "origin/main", behind: 2, ahead: 0,
    conflicts: [], lockfileChanged: false, checkedAt: 1, projectId: null, failure: null,
  };
  let released = false;
  const local = {
    id: localId,
    observe: () => ({
      getSnapshot: () => ({ phase: "current", failure: null,
        value: { kind: "update", subscriptionId: randomUUID(), generation: 1, revision: 1,
          phase: "current", failure: null, data: update } }),
      release: () => { released = true; },
    }),
  };
  const remote = { id: remoteId, observe: () => assert.fail("Remote installation update should not be queried.") };
  const f = await fixture(context, { attached: local, get: id => id === localId ? local : id === remoteId ? remote : undefined });
  const subscriptionId = randomUUID();
  const received = f.owner.observe({ subscriptionId, generation: 1, query: { kind: "daemonUpdate", daemonId: localId } });
  assert.equal(received.kind, "daemonUpdate");
  if (received.kind === "daemonUpdate") assert.deepEqual(received.data, update);
  const remoteValue = f.owner.observe({ subscriptionId, generation: 2, query: { kind: "daemonUpdate", daemonId: remoteId } });
  assert.equal(remoteValue.kind, "daemonUpdate");
  if (remoteValue.kind === "daemonUpdate") assert.equal(remoteValue.data, null);
  assert.equal(released, true);
});

test("pending browser-state binding cannot block already-available app presentation", async context => {
  const f = await fixture(context);
  const pending = Promise.withResolvers<WorkbenchClientStateResponse>();
  f.read(() => pending.promise);
  const stateQuery = f.owner.observe({ subscriptionId: randomUUID(), generation: 1,
    query: { kind: "appState", browserStateId: null } });
  assert.equal(stateQuery.phase, "pending");
  const presentation = f.owner.observe({ subscriptionId: randomUUID(), generation: 1, query: { kind: "presentation" } });
  assert.equal(presentation.phase, "current");
  assert.ok(presentation.kind === "presentation" && presentation.data);
  pending.resolve(state(1));
  await f.wait(value => value.kind === "appState" && value.phase === "current");
});

test("project groups use their own observation response without changing projects", async context => {
  const f = await fixture(context);
  const groups = f.owner.observe({ subscriptionId: randomUUID(), generation: 1,
    query: { kind: "projectGroups" } });
  assert.equal(groups.kind, "projectGroups");
  if (groups.kind !== "projectGroups") return;
  assert.deepEqual(groups.data, {
    orderedProjectIds: [], unsettledProjectIds: [], unarchivedProjectIds: [],
  });
  const projects = f.owner.observe({ subscriptionId: randomUUID(), generation: 1,
    query: { kind: "projects" } });
  assert.equal(projects.kind, "projects");
  assert.equal(Object.hasOwn(projects, "projectGroups"), false);
});

test("state invalidations coalesce during one read and a final change is not lost", async context => {
  const f = await fixture(context);
  const first = Promise.withResolvers<WorkbenchClientStateResponse>();
  const last = Promise.withResolvers<WorkbenchClientStateResponse>();
  const secondEntered = Promise.withResolvers<void>();
  let calls = 0;
  f.read(() => {
    if (++calls === 1) return first.promise;
    secondEntered.resolve(); return last.promise;
  });
  f.owner.observe({ subscriptionId: randomUUID(), generation: 1, query: { kind: "appState", browserStateId: null } });
  for (let index = 0; index < 20; index++) f.changed();
  assert.equal(calls, 1);
  first.resolve(state(1));
  await secondEntered.promise;
  assert.equal(calls, 2);
  last.resolve(state(2));
  await f.wait(value => value.kind === "appState" && value.data?.revision === 2);
  assert.equal(calls, 2);
});

test("a failed app-state refresh retains usable facts and only a new invalidation retries", async context => {
  const f = await fixture(context);
  let calls = 0;
  f.read(async () => {
    if (++calls === 2) throw new Error("state storage unavailable");
    return state(calls);
  });
  f.owner.observe({ subscriptionId: randomUUID(), generation: 1, query: { kind: "appState", browserStateId: null } });
  await f.wait(value => value.kind === "appState" && value.phase === "current");
  f.changed();
  const failed = await f.wait(value => value.kind === "appState" && value.phase === "failed");
  assert.equal(failed.kind === "appState" ? failed.data?.revision : null, 1);
  assert.equal(calls, 2);
  assert.equal(f.warnings.length, 1);
  f.changed();
  await f.wait(value => value.kind === "appState" && value.data?.revision === 3);
});

test("stats observations relay each daemon revision, including claim freshness, and release with the interest", async context => {
  let snapshot: { phase: "pending" | "current"; failure: null; value: object | null } = { phase: "pending", failure: null, value: null };
  let notify = () => {};
  const observed: object[] = [];
  let released = 0;
  const daemonId = DaemonIdSchema.parse(randomUUID());
  const source = {
    id: daemonId,
    observe: (query: object, listener: () => void) => {
      observed.push(query);
      notify = listener;
      return { getSnapshot: () => snapshot, release: () => { released += 1; } };
    },
  };
  const f = await fixture(context, { get: (id) => id === daemonId ? source : undefined });
  const subscriptionId = randomUUID();
  const request = { model: null, period: null, projectIds: null, provider: null, range: "7d" as const, tokenTypes: ["input" as const, "output" as const] };
  const initial = f.owner.observe({ subscriptionId, generation: 1, query: { kind: "stats", daemonId, request } });
  assert.ok(initial.kind === "stats" && initial.phase === "pending");
  assert.deepEqual(observed, [{ kind: "stats", request }]);
  const data = { generatedAt: 7 };
  for (const claimsPhase of ["pending", "current"] as const) {
    snapshot = { phase: "current", failure: null, value: { kind: "stats", claimsPhase, data } };
    notify();
    const relayed = await f.wait(value => value.kind === "stats" && value.claimsPhase === claimsPhase);
    assert.ok(relayed.kind === "stats" && relayed.data === data && relayed.phase === "current");
  }
  f.owner.release({ subscriptionId, generation: 1 });
  assert.equal(released, 1);
});

test("a thread row observation publishes only that thread's row from its owner project, then patches it", async context => {
  const daemonId = DaemonIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse("project");
  const threadId = WorkbenchThreadIdSchema.parse("00000001-0000-4000-8000-000000000000");
  const otherId = WorkbenchThreadIdSchema.parse("00000002-0000-4000-8000-000000000000");
  const entry = (id: typeof threadId, title: string) => ({
    entryKind: "thread" as const, title, activityAt: 10_000, waitingOnThreads: [],
    compacting: true,
    identity: { harness: "codex" as const, threadId: id },
    metadata: { archived: false as const, pinned: false, snoozed: false },
    lifecycle: { kind: "needsAttention" as const, reason: "noActiveTurn" as const, settled: false as const },
  });
  let title = "first";
  let notify = () => {};
  const observed: object[] = [];
  const source = {
    id: daemonId,
    observe: (query: object, listener: () => void) => {
      observed.push(query);
      notify = listener;
      return { getSnapshot: () => ({ phase: "current", failure: null, value: { kind: "projectThreads", projects: [{
        projectId, phase: "current", failure: null,
        sidebar: { projectId, revision: 1, freshness: "fresh", error: null, displayOrder: {}, entries: [entry(otherId, "other"), entry(threadId, title)] },
      }] } }), release: () => {} };
    },
    socket: { onNotification: () => () => {} },
  };
  const owner = { phase: "current" as const, identity: { threadId, projectId, harness: "codex" as const }, location: { daemonId, projectId }, logicalProjectId: null };
  const f = await fixture(context, { get: id => id === daemonId ? source : undefined }, {
    observe: (id: string) => ({ getSnapshot: () => id === threadId ? owner : { phase: "unavailable" as const, failure: "unknown" }, release: () => {} }),
  });
  const initial = f.owner.observe({ subscriptionId: randomUUID(), generation: 1, query: { kind: "threadRow", threadId: ThreadReferenceSchema.parse(threadId) } });
  assert.deepEqual(observed, [{ kind: "projectThreads", projectIds: [projectId] }]);
  assert.ok(initial.kind === "threadRow" && initial.phase === "current");
  assert.equal(initial.data?.entry.entryKind === "thread" && initial.data.entry.title, "first");
  assert.equal(initial.data?.entry && "compacting" in initial.data.entry, false);
  title = "renamed";
  notify();
  const patched = await f.wait(value => value.kind === "threadRow" && value.data?.entry.entryKind === "thread" && value.data.entry.title === "renamed");
  assert.ok(patched);
  assert.deepEqual(f.deltas.at(-1)?.delta, { objects: { data: { objects: { entry: { set: { title: "renamed" } } } } } });
  const unknown = f.owner.observe({ subscriptionId: randomUUID(), generation: 1,
    query: { kind: "threadRow", threadId: ThreadReferenceSchema.parse("00000003-0000-4000-8000-000000000000") } });
  assert.ok(unknown.kind === "threadRow" && unknown.data === null && unknown.phase === "unavailable");
});

test("project rows forward v2 compaction and strip it for legacy browsers", async context => {
  const daemonId = DaemonIdSchema.parse(randomUUID());
  const projectId = ProjectIdSchema.parse("project");
  const threadId = WorkbenchThreadIdSchema.parse("00000001-0000-4000-8000-000000000000");
  const observed: object[] = [];
  const source = {
    id: daemonId,
    observe: (query: object) => {
      observed.push(query);
      return { getSnapshot: () => ({ phase: "current", failure: null, value: {
        kind: "projectThreads", projects: [{ projectId, phase: "current", failure: null, sidebar: {
          projectId, revision: 1, freshness: "fresh", error: null, displayOrder: {}, entries: [{
            entryKind: "thread" as const, title: "Compacting", activityAt: 10_000, waitingOnThreads: [],
            compacting: true, identity: { harness: "codex" as const, threadId },
            metadata: { archived: false as const, pinned: false, snoozed: false },
            lifecycle: { kind: "completed" as const, reason: "providerInactive" as const, settled: false as const },
          }],
        } }],
      } }), release: () => {} };
    },
    socket: { onNotification: () => () => {} },
  };
  const f = await fixture(context, { get: id => id === daemonId ? source : undefined });
  const workspace = f.workspace.getSnapshot();
  context.mock.method(f.workspace, "getSnapshot", () => ({
    ...workspace,
    observedProjects: [{
      identityKey: ProjectIdentityKeySchema.parse("local:///repo/project"), registrationFailure: null,
      locations: [{ location: { daemonId, projectId }, hostname: "remote", project: {
        id: projectId, kind: "git" as const, name: "project", relativePath: "project",
        rootPath: "/repo/project", roots: [], lastCommitTimeMs: null,
      } }],
    }],
  }));
  const projects = [{ kind: "location" as const, location: { daemonId, projectId } }];
  const current = f.owner.observe({ subscriptionId: randomUUID(), generation: 1,
    query: { kind: "projectThreads", projects, sidebarRowVersion: 2 } });
  assert.deepEqual(observed[0], { kind: "projectThreads", projectIds: [projectId], sidebarRowVersion: 2 });
  assert.equal(current.kind === "projectThreads" && current.data.rows[0]?.entry.entryKind === "thread"
    ? current.data.rows[0].entry.compacting : null, true);
  const legacy = f.owner.observe({ subscriptionId: randomUUID(), generation: 1,
    query: { kind: "projectThreads", projects } });
  assert.deepEqual(observed[1], { kind: "projectThreads", projectIds: [projectId] });
  assert.equal(legacy.kind === "projectThreads" && legacy.data.rows[0]
    ? "compacting" in legacy.data.rows[0].entry : null, false);
});

test("closing a caller stops invalidations and fences its pending state read", async context => {
  const f = await fixture(context);
  const pending = Promise.withResolvers<WorkbenchClientStateResponse>();
  f.read(() => pending.promise);
  f.owner.observe({ subscriptionId: randomUUID(), generation: 1, query: { kind: "appState", browserStateId: null } });
  f.owner.dispose();
  const count = f.updates.length;
  pending.resolve(state(1));
  await pending.promise;
  assert.equal(f.changes.size, 0);
  assert.equal(f.updates.length, count);
});
