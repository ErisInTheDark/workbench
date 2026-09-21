/*
 * Exports:
 * - No production exports; feature tests prove repository-wide Git arc transition serialization, thread timestamp injection, card-read coalescing, and typed failures.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type GitArcFailureEnvelope,
  GitArcMissingClaimSetError,
  GitArcProposalAlreadyCommittedError,
} from "workbench-shared/workbench/git/git-arc-failures";
import { GitArcAcceptedProposalsError } from "./lib/workbench/git/GitArcProposalController";
import { GitCheckpointIgnoredPathsError } from "./lib/workbench/git/GitArcPlanController";
import { GitArcCollisionError } from "./lib/workbench/git/GitArcRegistry";
import { GitCheckpointMissingObjectError } from "./lib/workbench/git/GitCheckpointStore";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import { GitArcRejectionError } from "workbench-shared/workbench/git/git-arc-rejections";
import { WorkspaceGitArcMemberError } from "./WorkbenchWorkspaceGitArcController";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";
import type { WorkbenchGitClaimSnapshot } from "./stats/git-claim-observation";
import { GitArcStartDiagnosticError } from "./lib/workbench/git/git-arc-start-diagnostics";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type { WorkbenchThreadIdentityRecord } from "./database/thread-identity/workbench-thread-identity-types";

function wbThreadId(harness: string, threadId: string, projectId = "project") {
  return `wb:${projectId}:${harness}:${threadId}`;
}

function gitFixtureIdentities() {
  const records: WorkbenchThreadIdentityRecord[] = ["project", "workspace"].flatMap(projectId =>
    ["codex", "opencode"].flatMap(harness =>
      ["thread", "thread-one", "thread-two", "sibling", "owner-thread", "starting-thread"].map(nativeThreadId => ({
        threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(`wb:${projectId}:${harness}:${nativeThreadId}`),
        projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(projectId),
        projectRoot: "C:/Git/Project",
        bindings: [{
          harness, nativeLocation: "C:/Git/Project",
          nativeThreadId: fixtureIdentitySchemas.NativeThreadIdSchema.parse(nativeThreadId),
          pending: true, turnIndex: null,
        }],
      }))));
  return new WorkbenchThreadIdentityController({
    listThreadIdentities: async () => records,
    resolveThreadIdentity: async input => records.find(record =>
      (!input.projectId || record.projectId === input.projectId)
      && (!input.harness || record.bindings[0].harness === input.harness)
      && (record.threadId === input.threadId || record.bindings[0].nativeThreadId === input.threadId)) ?? null,
    resolveNativeThreadIdentity: async input => records.find(record =>
      record.bindings[0].harness === input.harness && record.bindings[0].nativeThreadId === input.nativeThreadId) ?? null,
    resolveTurnIdentity: async () => { throw new Error("Git fixtures do not resolve turns."); },
    observeThreadIdentities: async () => { throw new Error("Git fixtures do not admit threads."); },
    observeTurnIdentities: async () => { throw new Error("Git fixtures do not admit turns."); },
  });
}

function waitFeature() {
  return new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => ({
      lifecycle: { agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }, kind: "working", reason: "acceptedIntent", settled: false },
      title: "Waiting thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
}

test("proposal dispatch preserves on-demand inspection and inspected selection", async () => {
  const feature = waitFeature();
  const internal = feature as unknown as {
    controller: {
      getProposal: (input: object) => Promise<object>;
      commitProposal: (input: object) => Promise<object>;
    };
  };
  internal.controller.getProposal = async input => input;
  internal.controller.commitProposal = async input => input;
  const common = {
    cwd: "C:/Git/Project", harness: "codex" as const, threadId: "thread",
    proposalId: "proposal-one", includeNewer: false,
  };
  const response = await feature.executeRequest({ ...common, action: "proposalState", includeUnclaimed: true });
  assert.equal((await response.json() as { includeUnclaimed?: boolean }).includeUnclaimed, true);
  const unclaimedSelection = { paths: ["loose.txt"], tree: "a".repeat(40) };
  const committed = await feature.executeRequest({
    ...common, action: "proposalCommit", description: "", title: "commit",
    mode: "commit", unclaimedSelection,
  });
  const result = await committed.json() as { unclaimedSelection?: typeof unclaimedSelection; mode?: string };
  assert.deepEqual(result.unclaimedSelection, unclaimedSelection);
  assert.equal(result.mode, "commit");
});

test("startup claim reconciliation seeds current scopes at observation time", async () => {
  const snapshots: WorkbenchGitClaimSnapshot[] = [];
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => null,
    observeClaimSnapshot: (snapshot) => snapshots.push(snapshot),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({
      cwd: "C:/workspace/api",
      project: {
        id: fixtureIdentitySchemas.ProjectIdSchema.parse("workspace"),
        kind: "workspace",
        root: "C:/workspace/api",
        rootPath: "C:/workspace/api",
        roots: [
          { id: "api", name: "API", root: "C:/workspace/api", rootPath: "C:/workspace/api" },
          { id: "web", name: "Web", root: "C:/workspace/web", rootPath: "C:/workspace/web" },
        ],
      },
      root: { id: "api", name: "API", root: "C:/workspace/api", rootPath: "C:/workspace/api" },
    }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  const internal = feature as unknown as {
    workspaceController: {
      listLifecycleStates: () => Promise<Array<{
        claimedPaths: string[];
        harness: string;
        threadId: string;
      }>>;
    };
  };
  internal.workspaceController.listLifecycleStates = async () => [{
    claimedPaths: ["api:src", "web:packages/ui"],
    harness: "codex",
    threadId: "thread",
  }];
  const startedAt = Date.now();
  await feature.reconcileClaimSnapshots("C:/workspace/api");
  assert.deepEqual(snapshots[0]?.roots, [
    { paths: ["src"], rootId: "api" },
    { paths: ["packages/ui"], rootId: "web" },
  ]);
  assert.ok((snapshots[0]?.observedAt ?? 0) >= startedAt);
});

for (const driftAfterRelease of [false, true]) test(`competing Git arc waits revalidate after release with drift=${driftAfterRelease}`, async () => {
  const transitions = new WorkbenchThreadTransitionCoordinator();
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async (_projectId, _harness, threadId) => ({
      lifecycle: { agent: { agentStatus: "working", turnId: fixtureIdentitySchemas.WorkbenchTurnIdSchema.parse("turn") }, kind: "working", reason: "acceptedIntent", settled: false },
      title: threadId,
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions,
  });
  const internal = feature as unknown as {
    controller: {
      findPlanClaimCollisions: (input: { checkpointCommit?: string; threadId: string }) => Promise<object>;
      releaseArc: (input: { threadId: string }) => Promise<object>;
      startArc: (input: { checkpointCommit?: string; threadId: string }) => Promise<object>;
    };
  };
  let owner: string | null = null;
  const comparison = Array.from({ length: 30 }, (_, index) => ({
    additions: index + 1, deletions: index, binary: false,
    kind: "update" as const,
    path: `src/${"long-path/".repeat(30)}file-${index}.ts`,
  }));
  let reportSecondBlocked!: () => void;
  const secondBlocked = new Promise<void>((resolve) => { reportSecondBlocked = resolve; });
  internal.controller.findPlanClaimCollisions = async ({ checkpointCommit, threadId }) => {
    if (owner && owner !== threadId && threadId === wbThreadId("codex", "thread-two")) reportSecondBlocked();
    return {
      checkpointCommit: checkpointCommit ?? "a".repeat(40),
      collisions: owner && owner !== threadId ? [{
        entry: {
          checkpointCommit: "f".repeat(40), claimedPaths: ["src/a.ts"], harness: "codex", intentDescription: "",
          intentName: "Competing wait", threadId: owner, updatedAt: "2026-08-27T00:00:00.000Z",
        },
        overlaps: [{ claimedPath: "src/a.ts", requestedPath: "src/a.ts" }],
      }] : [],
      repoRoot: "C:/Git/Project",
      scopePaths: ["src/a.ts"],
    };
  };
  internal.controller.startArc = async ({ checkpointCommit, threadId }) => {
    if (driftAfterRelease && threadId === wbThreadId("codex", "thread-two")) {
      throw new GitArcStartDiagnosticError("Plan changed after publication.", {
        comparison,
        collisions: [], commitChanges: [], dirtyUnclaimedPaths: ["src/a.ts"], headMovement: "same",
        planCheckpointCommit: checkpointCommit!, snapshotDrift: ["src/a.ts"],
      });
    }
    owner = threadId;
    return {
      acquiredClaims: ["src/a.ts"],
      changes: [],
      checkpointCommit: checkpointCommit ?? "a".repeat(40),
      intentName: threadId,
      releasedClaims: [],
      repoRoot: "C:/Git/Project",
      scopePaths: ["src/a.ts"],
    };
  };
  internal.controller.releaseArc = async ({ threadId }) => {
    if (owner === threadId) owner = null;
    return {
      checkpointCommit: "a".repeat(40), intentName: threadId, kind: "arc",
      releasedClaims: ["src/a.ts"], repoRoot: "C:/Git/Project", scopePaths: [],
    };
  };
  const request = (threadId: string, checkpointCommit: string) => ({
    action: "arcWait" as const, checkpointCommit, cwd: "C:/Git/Project",
    harness: "codex" as const, threadId,
  });
  const first = feature.executeRequest(request("thread-one", "a".repeat(40)));
  const second = feature.executeRequest(request("thread-two", "b".repeat(40)));
  assert.equal((await first).status, 200);
  await secondBlocked;
  let secondFinished = false;
  void second.then(() => { secondFinished = true; });
  await Promise.resolve();
  assert.equal(secondFinished, false);
  assert.equal(owner, wbThreadId("codex", "thread-one"));

  assert.equal((await feature.executeRequest({
    action: "arcRelease", cwd: "C:/Git/Project", disown: false, harness: "codex", threadId: "thread-one",
  })).status, 200);
  const secondResponse = await second;
  if (driftAfterRelease) {
    assert.equal(secondResponse.status, 400);
    const result = await secondResponse.json() as GitArcFailureEnvelope;
    assert.equal(result.gitArcFailure.code, "planDrift");
    if (result.gitArcFailure.code !== "planDrift") throw new Error("Expected drift after release.");
    assert.equal(result.gitArcFailure.planRef, "b".repeat(40));
    assert.deepEqual(result.gitArcFailure.snapshotPaths, ["src/a.ts"]);
    assert.deepEqual(result.gitArcFailure.comparison, comparison);
    assert.equal(owner, null);
  } else {
    assert.equal(secondResponse.status, 200);
    assert.equal((await secondResponse.json() as { checkpointCommit: string }).checkpointCommit, "b".repeat(40));
    assert.equal(owner, wbThreadId("codex", "thread-two"));
  }
});

test("Git arc wait stops on caller cancellation and feature disposal", async () => {
  const createBlocked = () => {
    const feature = waitFeature();
    let reportRead!: () => void;
    const read = new Promise<void>((resolve) => { reportRead = resolve; });
    (feature as unknown as { controller: { findPlanClaimCollisions: () => Promise<object> } }).controller.findPlanClaimCollisions = async () => {
      reportRead();
      return {
        checkpointCommit: "a".repeat(40),
        collisions: [{ entry: {
          checkpointCommit: "b".repeat(40), claimedPaths: ["src/a.ts"], harness: "codex", intentDescription: "",
          intentName: "Sibling", threadId: "sibling", updatedAt: "2026-08-27T00:00:00.000Z",
        }, overlaps: [{ claimedPath: "src/a.ts", requestedPath: "src/a.ts" }] }],
        repoRoot: "C:/Git/Project",
        scopePaths: ["src/a.ts"],
      };
    };
    return { feature, read };
  };
  const request = {
    action: "arcWait", checkpointCommit: "a".repeat(40), cwd: "C:/Git/Project",
    harness: "codex" as const, threadId: "thread-one",
  };
  const cancelled = createBlocked();
  const caller = new AbortController();
  const cancelledResponse = cancelled.feature.executeRequest(request, caller.signal);
  await cancelled.read;
  caller.abort(new Error("steered"));
  assert.equal((await cancelledResponse).status, 400);

  const disposed = createBlocked();
  const disposedResponse = disposed.feature.executeRequest(request);
  await disposed.read;
  disposed.feature.dispose();
  assert.equal((await disposedResponse).status, 400);
});

test("sibling thread card reads share the Git read lease instead of taking the writer lane", async () => {
  const keys: string[] = [];
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: {
      read: async (key, operation) => {
        keys.push(`read:${key}`);
        return await operation();
      },
      run: async (key) => { throw new Error(`unexpected writer transition: ${key}`); },
    },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async () => Response.json({ changes: [] }),
  });
  const request = {
    action: "compare",
    checkpointCommit: "a".repeat(40),
    cwd: "ignored after validation",
  } as const;

  await feature.executeRequest({ ...request, harness: "codex", threadId: "thread-one" });
  await feature.executeRequest({ ...request, harness: "opencode", threadId: "thread-two" });

  assert.deepEqual(keys, ["read:C:/Git/Project", "read:C:/Git/Project"]);
});

test("exact concurrent proposal and claim card reads share one transition operation", async () => {
  for (const action of ["proposalState", "compare"] as const) {
    let dispatchCount = 0;
    let releaseDispatch: () => void = () => undefined;
    let reportDispatchStarted: () => void = () => undefined;
    const dispatchStarted = new Promise<void>((resolve) => { reportDispatchStarted = resolve; });
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
    let transitionCount = 0;
    const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
      getThreadCreatedAt: async () => 1,
      getThreadClaimContext: async () => null,
      refreshThreadGitArcState: async () => undefined,
      resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
      transitions: {
        read: async (_key, operation) => {
          transitionCount += 1;
          return await operation();
        },
        run: async () => { throw new Error("card reads must not take the writer lease"); },
      },
    });
    Object.defineProperty(feature, "dispatch", {
      value: async () => {
        dispatchCount += 1;
        reportDispatchStarted();
        await dispatchGate;
        return Response.json({ action, shared: true });
      },
    });
    const common = { action, cwd: "C:/Git/Project", harness: "codex" as const, threadId: "thread-one" };
    const request = action === "proposalState"
      ? { ...common, includeNewer: false, proposalId: "proposal-one" }
      : common;

    const first = feature.executeRequest(request);
    const duplicate = feature.executeRequest(request);
    await dispatchStarted;
    assert.equal(dispatchCount, 1);
    assert.equal(transitionCount, 1);
    releaseDispatch();
    const [firstResponse, duplicateResponse] = await Promise.all([first, duplicate]);

    assert.deepEqual(await firstResponse.json(), { action, shared: true });
    assert.deepEqual(await duplicateResponse.json(), { action, shared: true });
  }
});

test("a Git arc mutation fences later card reads from an older shared result", async () => {
  const coordinator = new WorkbenchThreadTransitionCoordinator();
  const transitionActions: string[] = [];
  let releaseFirstRead: () => void = () => undefined;
  let reportFirstReadStarted: () => void = () => undefined;
  let reportMutationQueued: () => void = () => undefined;
  const firstReadStarted = new Promise<void>((resolve) => { reportFirstReadStarted = resolve; });
  const firstReadGate = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
  const mutationQueued = new Promise<void>((resolve) => { reportMutationQueued = resolve; });
  let transitionCount = 0;
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: {
      read: async (key, operation) => {
        transitionCount += 1;
        return await coordinator.read(key, operation);
      },
      run: async (key, operation) => {
        transitionCount += 1;
        if (transitionCount === 2) reportMutationQueued();
        return await coordinator.run(key, operation);
      },
    },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async (request: { action: string }) => {
      transitionActions.push(request.action);
      if (transitionActions.length === 1) {
        reportFirstReadStarted();
        await firstReadGate;
      }
      return Response.json({ action: request.action, order: transitionActions.length });
    },
  });
  const readRequest = {
    action: "proposalState" as const,
    cwd: "C:/Git/Project",
    harness: "codex" as const,
    includeNewer: false,
    proposalId: "proposal-one",
    threadId: "thread-one",
  };

  const first = feature.executeRequest(readRequest);
  const duplicate = feature.executeRequest(readRequest);
  await firstReadStarted;
  const mutation = feature.executeRequest({
    action: "proposalRescind",
    cwd: "C:/Git/Project",
    harness: "codex",
    proposalId: "proposal-one",
    threadId: "thread-one",
  });
  await mutationQueued;
  const afterMutation = feature.executeRequest(readRequest);
  releaseFirstRead();
  const [firstResponse, duplicateResponse, mutationResponse, afterMutationResponse] = await Promise.all([
    first, duplicate, mutation, afterMutation,
  ]);

  assert.deepEqual(await firstResponse.json(), { action: "proposalState", order: 1 });
  assert.deepEqual(await duplicateResponse.json(), { action: "proposalState", order: 1 });
  assert.deepEqual(await mutationResponse.json(), { action: "proposalRescind", order: 2 });
  assert.deepEqual(await afterMutationResponse.json(), { action: "proposalState", order: 3 });
  assert.equal(transitionCount, 3);
  assert.deepEqual(transitionActions, ["proposalState", "proposalRescind", "proposalState"]);
});

test("compare forwards an explicit inspection ref to the controller", async () => {
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 42,
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  let receivedRef: string | undefined;
  let receivedModifiedSince: number | undefined;
  const inspectionSnapshot = {};
  let compareSnapshot: object | undefined;
  let dirtSnapshot: object | undefined;
  const internal = (feature as unknown as {
    controller: {
      createInspectionSnapshot: (cwd: string) => Promise<object>;
      compare: (input: { ref?: string }, snapshot?: object) => Promise<object>;
      listUnclaimedWorkspaceDirt: (input: { modifiedSince: number }, snapshot?: object) => Promise<string[]>;
    };
  }).controller;
  internal.createInspectionSnapshot = async () => inspectionSnapshot;
  internal.compare = async (input, snapshot) => {
    receivedRef = input.ref;
    compareSnapshot = snapshot;
    return {};
  };
  internal.listUnclaimedWorkspaceDirt = async (input, snapshot) => {
    receivedModifiedSince = input.modifiedSince;
    dirtSnapshot = snapshot;
    return ["unclaimed.ts"];
  };

  const response = await feature.executeRequest({
    action: "compare",
    cwd: "C:/Git/Project",
    harness: "codex",
    ref: "proposal-one",
    threadId: "thread-one",
  });

  assert.equal(response.status, 200);
  assert.equal(receivedRef, "proposal-one");
  assert.equal(receivedModifiedSince, 42);
  assert.equal(compareSnapshot, inspectionSnapshot);
  assert.equal(dirtSnapshot, inspectionSnapshot);
  assert.deepEqual(await response.json(), { unclaimedDirtPaths: ["unclaimed.ts"] });
});

test("arc release forwards explicit dirty disown intent to the controller", async () => {
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  let receivedDisown: boolean | undefined;
  const internal = (feature as unknown as {
    controller: { releaseArc: (input: { disown: boolean }) => Promise<object> };
  }).controller;
  internal.releaseArc = async (input) => {
    receivedDisown = input.disown;
    return {};
  };

  const response = await feature.executeRequest({
    action: "arcRelease",
    cwd: "C:/Git/Project",
    disown: true,
    harness: "codex",
    threadId: "thread-one",
  });

  assert.equal(response.status, 200);
  assert.equal(receivedDisown, true);
});

test("settled threads cannot start claims", async () => {
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "userCompleted", settled: true },
      title: "Finished thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  const response = await feature.executeRequest({
    action: "arcStart",
    checkpointCommit: "a".repeat(40),
    cwd: "C:/Git/Project",
    harness: "codex",
    threadId: "thread-one",
  });
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /settled thread cannot start or continue/u);
});

test("atomic claim collisions use structured owner and path diagnostics", async () => {
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async (_projectId, _harness, threadId) => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: threadId === "wb:project:opencode:owner-thread" ? "Render ownership" : "Starting thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async () => {
      throw new GitArcCollisionError([{
        entry: {
          checkpointCommit: "b".repeat(40),
          claimedPaths: ["app/client/components/workbench"],
          harness: "opencode",
          intentDescription: "",
          intentName: "change rendering",
          phase: "active",
          threadId: wbThreadId("opencode", "owner-thread"),
          updatedAt: "2026-08-21T00:00:00.000Z",
        },
        overlaps: [{
          claimedPath: "app/client/components/workbench",
          requestedPath: "app/client/components/workbench/thread-view/ThreadView.tsx",
        }],
      }]);
    },
  });

  const response = await feature.executeRequest({
    action: "arcStart",
    checkpointCommit: "a".repeat(40),
    cwd: "C:/Git/Project",
    harness: "codex",
    threadId: "starting-thread",
  });
  const result = await response.json() as GitArcFailureEnvelope;
  assert.equal(response.status, 400);
  assert.equal(result.gitArcFailure.code, "siblingClaimCollision");
  assert.equal(result.gitArcFailure.action, "arcStart");
  assert.match(result.error, /opencode\/wb:project:opencode:owner-thread.*Render ownership.*completed/u);
  assert.match(result.error, /claims app\/client\/components\/workbench through requested path app\/client\/components\/workbench\/thread-view\/ThreadView\.tsx/u);
  if (result.gitArcFailure.code !== "siblingClaimCollision") throw new Error("Expected a collision failure.");
  assert.deepEqual(result.gitArcFailure.conflicts[0], {
    overlaps: [{
      claimedPath: "app/client/components/workbench",
      requestedPath: "app/client/components/workbench/thread-view/ThreadView.tsx",
    }],
    owner: {
      checkpointCommit: "b".repeat(40),
      harness: "opencode",
      intentName: "change rendering",
      lifecycle: "completed",
      threadId: "wb:project:opencode:owner-thread",
      title: "Render ownership",
    },
  });
});

test("missing arc refs return one typed message without unrelated recovery", async () => {
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: "Starting thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async () => { throw new GitCheckpointMissingObjectError("deadbeef"); },
  });

  const response = await feature.executeRequest({
    action: "arcStart",
    checkpointCommit: "deadbeef",
    cwd: "C:/Git/Project",
    harness: "codex",
    threadId: "thread-one",
  });
  const result = await response.json() as GitArcFailureEnvelope;
  assert.deepEqual(result.gitArcFailure, {
    action: "arcStart",
    code: "missingArcRef",
    ref: "deadbeef",
    version: 1,
  });
  assert.equal(result.error, "There is no git arc by the `deadbeef` ref.");
});

test("ignored path failures remain typed through workspace member wrappers", async () => {
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async () => {
      throw new Error("Workspace Git arc member failed", {
        cause: new GitCheckpointIgnoredPathsError(["ignored/output.ts"]),
      });
    },
  });

  const response = await feature.executeRequest({
    action: "planAdd",
    cwd: "C:/Git/Project",
    harness: "codex",
    paths: ["ignored/output.ts"],
    threadId: "thread-one",
  });
  const result = await response.json() as GitArcFailureEnvelope;
  assert.equal(response.status, 400);
  assert.deepEqual(result.gitArcFailure, {
    action: "planAdd",
    code: "ignoredPaths",
    paths: ["ignored/output.ts"],
    version: 1,
  });
  assert.match(result.error, /Git ignores the selected file\./u);
  assert.match(result.error, /failed to plan ignored file ignored\/output\.ts/u);
  assert.doesNotMatch(result.error, /Workspace Git arc member failed|operation rejected/u);
});

test("owner rejections survive the feature boundary without losing structured reasons", async () => {
  const feature = waitFeature();
  const workspace = { failedRootIds: ["web"], completedRootIds: ["api"], stage: "operation" as const };
  Object.defineProperty(feature, "dispatch", {
    value: async () => {
      throw new WorkspaceGitArcMemberError(workspace, new GitArcRejectionError({ reason: "unclaimedRemoval", paths: ["one.ts"] }, "agent-only recovery"));
    },
  });
  const response = await feature.executeRequest({
    action: "arcContinue", cwd: "C:/Git/Project", harness: "codex", threadId: "thread-one",
  });
  const result = await response.json() as GitArcFailureEnvelope;
  assert.equal(response.status, 400);
  assert.equal(result.gitArcFailure.code, "rejection");
  if (result.gitArcFailure.code !== "rejection") throw new Error("Typed rejection was lost.");
  assert.deepEqual(result.gitArcFailure.rejection, { reason: "unclaimedRemoval", paths: ["one.ts"] });
  assert.equal(result.gitArcFailure.diagnostic, "agent-only recovery");
  assert.deepEqual(result.gitArcFailure.workspace, workspace);
});

test("accepted proposal receipts remain structured when a resolved arc cannot continue", async () => {
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: "Resolved thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async () => {
      throw new GitArcAcceptedProposalsError([{
        commitSha: "b".repeat(40),
        proposalId: "80d73f22-2adc-4bd3-83e0-affa363743eb",
        title: "fix accepted arc work",
      }], []);
    },
  });

  const response = await feature.executeRequest({
    action: "arcContinue",
    checkpointCommit: "a".repeat(40),
    cwd: "C:/Git/Project",
    harness: "codex",
    threadId: "thread-one",
  });
  const result = await response.json() as GitArcFailureEnvelope;
  assert.equal(response.status, 400);
  assert.deepEqual(result.gitArcFailure, {
    action: "arcContinue",
    claimedPaths: [],
    code: "acceptedProposals",
    proposals: [{
      commitSha: "b".repeat(40),
      proposalId: "80d73f22-2adc-4bd3-83e0-affa363743eb",
      title: "fix accepted arc work",
    }],
    version: 1,
  });
  assert.match(result.error, /already resolved and owns no live claims/u);
  assert.match(result.error, /fix accepted arc work \(b{40}\)/u);
  assert.doesNotMatch(result.error, /80d73f22-2adc-4bd3-83e0-affa363743eb|wb git arc/u);
  assert.match(result.error, /git_arc_claims/u);
});

test("known proposal and claim-set errors keep recovery typed", async () => {
  const cases = [{
    action: "proposalCreate" as const,
    error: new GitArcProposalAlreadyCommittedError(
      "b".repeat(40),
      "80d73f22-2adc-4bd3-83e0-affa363743eb",
      "fix committed arc work",
    ),
    expected: {
      action: "proposalCreate",
      code: "proposalAlreadyCommitted",
      commitSha: "b".repeat(40),
      proposalId: "80d73f22-2adc-4bd3-83e0-affa363743eb",
      proposalTitle: "fix committed arc work",
      version: 1,
    },
  }, {
    action: "compare" as const,
    error: new GitArcMissingClaimSetError(),
    expected: { action: "compare", code: "missingClaimSet", version: 1 },
  }];

  for (const item of cases) {
    const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
      getThreadCreatedAt: async () => 1,
      getThreadClaimContext: async () => null,
      refreshThreadGitArcState: async () => undefined,
      resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
      transitions: { run: async (_key, operation) => await operation() },
    });
    Object.defineProperty(feature, "dispatch", { value: async () => { throw item.error; } });
    const request = item.action === "proposalCreate"
      ? { action: item.action, amend: false, cwd: "C:/Git/Project", description: "", harness: "codex", threadId: "thread-one", title: "replacement" }
      : { action: item.action, cwd: "C:/Git/Project", harness: "codex", threadId: "thread-one" };
    const response = await feature.executeRequest(request);
    const result = await response.json() as GitArcFailureEnvelope;
    assert.equal(response.status, 400);
    assert.deepEqual(result.gitArcFailure, item.expected);
  }
});

test("successful Git responses survive a failed thread claim refresh", async (context) => {
  const reported = context.mock.method(console, "error", () => undefined);
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => { throw new Error("projection exploded"); },
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async () => Response.json({ proposalId: "proposal-one" }),
  });

  const response = await feature.executeRequest({
    action: "proposalCreate",
    amend: false,
    cwd: "C:/Git/Project",
    description: "",
    harness: "codex",
    threadId: "thread-one",
    title: "Proposal",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { proposalId: "proposal-one" });
  assert.equal(reported.mock.callCount(), 1);
  assert.match(String(reported.mock.calls[0]?.arguments[0]), /mutation attempt.*projection exploded/u);
});

test("failed Git mutations still refresh durable arc projection once", async () => {
  let refreshCount = 0;
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => { refreshCount += 1; },
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", { value: async () => { throw new Error("mutation failed"); } });

  const response = await feature.executeRequest({
    action: "proposalCreate",
    amend: false,
    cwd: "C:/Git/Project",
    description: "",
    harness: "codex",
    threadId: "thread-one",
    title: "Proposal",
  });

  assert.equal(response.status, 400);
  const result = await response.json() as GitArcFailureEnvelope;
  assert.equal(result.gitArcFailure.code, "operationRejected");
  assert.match(result.error, /mutation failed/u);
  assert.equal(refreshCount, 1);
});

test("plan creation and applied arc moves refresh Git arc state while move previews do not", async () => {
  let refreshCount = 0;
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => { refreshCount += 1; },
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", { value: async () => Response.json({ ok: true }) });

  const common = { cwd: "C:/Git/Project", harness: "codex", threadId: "thread-one" } as const;
  assert.equal((await feature.executeRequest({
    action: "plan",
    intentDescription: "",
    intentName: "plan",
    paths: ["src/a.ts"],
    ...common,
  })).status, 200);
  assert.equal(refreshCount, 1);

  assert.equal((await feature.executeRequest({
    action: "arcMove",
    move: { confirm: false, kind: "regex", pattern: "^src/(.+)$", replacement: "tests/$1", roots: ["src"] },
    ...common,
  })).status, 200);
  assert.equal(refreshCount, 1);

  assert.equal((await feature.executeRequest({
    action: "arcMove",
    move: { kind: "operands", operands: ["src/a.ts", "tests/a.ts"] },
    ...common,
  })).status, 200);
  assert.equal(refreshCount, 2);
});

test("Git arc responses ignore legacy reload projections and admission claims", async () => {
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getReloadScopesForPaths: () => ["server:mcp"],
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    reloadScopeProjectRoot: "C:/Git/Project",
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async (request: { paths: string[] }) => Response.json({ scopePaths: request.paths }),
  });
  const request = {
    action: "plan" as const,
    cwd: "ignored",
    harness: "codex" as const,
    intentName: "reload",
    paths: ["daemon/server/WorkbenchAgentMcpController.ts"],
    threadId: "thread-one",
  };
  const response = await feature.executeRequest(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    scopePaths: ["daemon/server/WorkbenchAgentMcpController.ts"],
  });
  assert.deepEqual(await feature.listReloadScopeClaims("C:/Git/Project"), []);
});

test("reloadable Git arc dispatch owns current-plan and proposal lifecycle actions", async () => {
  const calls: string[] = [];
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async () => 1,
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: "Thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  const internal = (feature as unknown as { controller: Record<string, (...args: never[]) => Promise<object>> }).controller;
  internal.createInspectionSnapshot = async () => ({});
  for (const method of ["createPlan", "addToPlan", "removeFromPlan", "adoptIntoPlan", "createAndStartPlan", "editPlanClaims", "editArcClaims", "readScope", "readStatus", "continueArc", "startArc", "rescindProposal", "diff", "createProposal"] as const) {
    internal[method] = async () => { calls.push(method); return {}; };
  }
  internal.listUnclaimedWorkspaceDirt = async () => [];
  const common = { cwd: "C:/Git/Project", harness: "codex" as const, threadId: "thread-one" };
  const requests = [
    { action: "planClaims", inherit: false, intentName: "draft", addPaths: ["new.ts"], ...common },
    { action: "arcClaims", inherit: true, addPaths: ["new.ts"], removePaths: ["old.ts"], ...common },
    { action: "arcScope", ...common },
    { action: "arcStatus", ...common },
    { action: "arcContinue", ...common },
    { action: "plan", intentDescription: "", intentName: "draft", paths: [], ...common },
    { action: "planAdd", paths: ["src/a.ts"], ...common },
    { action: "planRemove", paths: ["src/a.ts"], ...common },
    { action: "planAdopt", paths: ["src/dirty.ts"], ...common },
    { action: "planStart", intentDescription: "", intentName: "start", paths: ["src/a.ts"], ...common },
    { action: "arcStart", ...common },
    { action: "proposalRescind", proposalId: "proposal-one", ...common },
    { action: "diff", paths: ["src/a.ts"], ref: "abcdef1", ...common },
    { action: "proposalCreate", amendProposalId: "proposal-one", description: "", title: "amend", ...common },
  ];
  const statuses = await Promise.all(requests.map(async (request) => (await feature.executeRequest(request)).status));
  assert.deepEqual(statuses, Array.from({ length: requests.length }, () => 200));
  assert.deepEqual([...calls].sort(), [
    "createPlan", "addToPlan", "removeFromPlan", "adoptIntoPlan", "createAndStartPlan", "editPlanClaims", "editArcClaims", "readScope", "readStatus", "continueArc", "startArc", "rescindProposal", "diff", "createProposal",
  ].sort());
});

test("status and proposal diff may inspect a cross-harness target without changing caller ownership", async () => {
  const calls: Array<{ action: string; harness: string; threadId: string; ref?: string }> = [];
  const timestamps: Array<{ harness: string; threadId: string }> = [];
  const feature = new WorkbenchGitArcFeature({
    identities: gitFixtureIdentities(),
    getThreadCreatedAt: async (_projectId, harness, threadId) => {
      timestamps.push({ harness, threadId });
      return 1;
    },
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: "Thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({
      cwd: "C:/Git/Project",
      project: { id: fixtureIdentitySchemas.ProjectIdSchema.parse("project") },
    }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  const internal = (feature as unknown as {
    controller: {
      createInspectionSnapshot: () => Promise<object>;
      diff: (input: { harness: string; threadId: string; ref?: string }) => Promise<object>;
      listUnclaimedWorkspaceDirt: () => Promise<string[]>;
      readStatus: (input: { harness: string; threadId: string }) => Promise<object>;
    };
  }).controller;
  internal.createInspectionSnapshot = async () => ({});
  internal.listUnclaimedWorkspaceDirt = async () => [];
  internal.readStatus = async input => {
    calls.push({ action: "status", ...input });
    return {
      pending: [], accepted: [], dirtyClaims: [], cleanClaims: [], unclaimedDirt: [],
      recovery: [], unavailableRecovery: [],
    };
  };
  internal.diff = async input => {
    calls.push({ action: "diff", ...input });
    return { changes: [], checkpointCommit: "a".repeat(40), diff: "", scopePaths: [] };
  };
  const caller = { cwd: "C:/Git/Project", harness: "codex" as const, threadId: "thread-one" };
  const targetThreadId = wbThreadId("opencode", "thread-two");
  assert.equal((await feature.executeRequest({
    action: "arcStatus", full: [], targetThreadId, ...caller,
  })).status, 200);
  assert.equal((await feature.executeRequest({
    action: "diff", ref: "proposal-one", targetThreadId, ...caller,
  })).status, 200);
  assert.deepEqual(calls, [
    { action: "status", cwd: "C:/Git/Project", harness: "opencode", threadId: targetThreadId },
    { action: "diff", cwd: "C:/Git/Project", harness: "opencode", ref: "proposal-one", threadId: targetThreadId },
  ]);
  assert.deepEqual(timestamps, [{ harness: "opencode", threadId: targetThreadId }]);
  assert.equal((await feature.executeRequest({
    action: "arcStatus", full: [], targetThreadId, ...caller, threadId: "missing-caller",
  })).status, 400);
  assert.equal(calls.length, 2);
});
