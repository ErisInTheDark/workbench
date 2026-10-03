/* No production exports. Protect independent app queries, coalescing, daemon stats relay and caller disposal. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import WorkbenchTemporaryDirectory from "../../../shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkbenchClientStateResponse } from "workbench-shared/state/workbench-client-state";
import type { WorkspaceObservation, WorkspaceObservationDelta } from "workbench-shared/workbench/workspace/workspace-observation";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchPresentationRepository from "../state/WorkbenchPresentationRepository";
import WorkbenchPresentationController from "../state/WorkbenchPresentationController";
import WorkbenchDaemonSources from "./WorkbenchDaemonSources";
import WorkbenchWorkspaceController from "./WorkbenchWorkspaceController";
import WorkbenchWorkspaceThreads from "./WorkbenchWorkspaceThreads";
import WorkbenchWorkspaceRequestController from "./WorkbenchWorkspaceRequestController";

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
async function fixture(context: TestContext, daemons?: { get(daemonId: string): object | undefined }) {
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
  const owner = new WorkbenchWorkspaceRequestController({
    workspace, threads, presentation,
    sources: daemons ? Object.assign(Object.create(sources) as typeof sources, daemons) : sources,
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
  return { owner, updates, deltas, providerEvents, warnings, changes,
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
