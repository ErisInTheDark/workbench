/*
 * Exports:
 * - No production exports; feature tests prove repository-wide Git arc transition serialization, card-read coalescing, and typed failures. Keywords: git, arc, orchestrator, transition, cache, concurrency, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type GitArcFailureEnvelope,
  GitArcMissingClaimSetError,
  GitArcProposalAlreadyCommittedError,
} from "../lib/workbench/git/git-arc-failures";
import { GitArcAcceptedProposalsError } from "../lib/workbench/git/GitArcProposalController";
import { GitCheckpointIgnoredPathsError } from "../lib/workbench/git/GitArcPlanController";
import { GitArcCollisionError } from "../lib/workbench/git/GitArcRegistry";
import { GitCheckpointMissingObjectError } from "../lib/workbench/git/GitCheckpointStore";
import WorkbenchGitArcFeature from "./WorkbenchGitArcFeature";
import WorkbenchThreadTransitionCoordinator from "./WorkbenchThreadTransitionCoordinator";

function waitFeature() {
  return new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => ({
      lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
      title: "Waiting thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
}

test("competing Git arc waits return one active owner and keep the loser waiting until release", async () => {
  const transitions = new WorkbenchThreadTransitionCoordinator();
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async (_projectId, _harness, threadId) => ({
      lifecycle: { agent: { agentStatus: "working", turnId: "turn" }, kind: "working", reason: "acceptedIntent", settled: false },
      title: threadId,
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
  let reportSecondBlocked!: () => void;
  const secondBlocked = new Promise<void>((resolve) => { reportSecondBlocked = resolve; });
  internal.controller.findPlanClaimCollisions = async ({ checkpointCommit, threadId }) => {
    if (owner && owner !== threadId && threadId === "thread-two") reportSecondBlocked();
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
  assert.equal(owner, "thread-one");

  assert.equal((await feature.executeRequest({
    action: "arcRelease", cwd: "C:/Git/Project", disown: false, harness: "codex", threadId: "thread-one",
  })).status, 200);
  const secondResponse = await second;
  assert.equal(secondResponse.status, 200);
  assert.equal((await secondResponse.json() as { checkpointCommit: string }).checkpointCommit, "b".repeat(40));
  assert.equal(owner, "thread-two");
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

test("sibling threads in one worktree share the Git arc transition lane", async () => {
  const keys: string[] = [];
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: {
      run: async (key: string) => {
        keys.push(key);
        throw new Error("stop after capturing the transition key");
      },
    },
  });
  const request = {
    action: "compare",
    checkpointCommit: "a".repeat(40),
    cwd: "ignored after validation",
  } as const;

  await feature.executeRequest({ ...request, harness: "codex", threadId: "thread-one" });
  await feature.executeRequest({ ...request, harness: "opencode", threadId: "thread-two" });

  assert.deepEqual(keys, ["C:/Git/Project", "C:/Git/Project"]);
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
      getThreadClaimContext: async () => null,
      refreshThreadGitArcState: async () => undefined,
      resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
      transitions: {
        run: async (_key, operation) => {
          transitionCount += 1;
          return await operation();
        },
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
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: {
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

test("compare forwards an explicit checkpoint ref to the controller", async () => {
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  let receivedCheckpointCommit: string | undefined;
  const internal = (feature as unknown as {
    controller: { compare: (input: { checkpointCommit?: string }) => Promise<object> };
  }).controller;
  internal.compare = async (input) => {
    receivedCheckpointCommit = input.checkpointCommit;
    return {};
  };

  const response = await feature.executeRequest({
    action: "compare",
    checkpointCommit: "a".repeat(40),
    cwd: "C:/Git/Project",
    harness: "codex",
    threadId: "thread-one",
  });

  assert.equal(response.status, 200);
  assert.equal(receivedCheckpointCommit, "a".repeat(40));
});

test("arc release forwards explicit dirty disown intent to the controller", async () => {
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "userCompleted", settled: true },
      title: "Finished thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
    getThreadClaimContext: async (_projectId, _harness, threadId) => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: threadId === "owner-thread" ? "Render ownership" : "Starting thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  Object.defineProperty(feature, "dispatch", {
    value: async () => {
      throw new GitArcCollisionError([{
        entry: {
          checkpointCommit: "b".repeat(40),
          claimedPaths: ["webapp/components/workbench"],
          harness: "opencode",
          intentDescription: "",
          intentName: "change rendering",
          phase: "active",
          threadId: "owner-thread",
          updatedAt: "2026-08-21T00:00:00.000Z",
        },
        overlaps: [{
          claimedPath: "webapp/components/workbench",
          requestedPath: "webapp/components/workbench/thread-view/ThreadView.tsx",
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
  assert.match(result.error, /opencode\/owner-thread.*Render ownership.*completed/u);
  assert.match(result.error, /claims webapp\/components\/workbench through requested path webapp\/components\/workbench\/thread-view\/ThreadView\.tsx/u);
  if (result.gitArcFailure.code !== "siblingClaimCollision") throw new Error("Expected a collision failure.");
  assert.deepEqual(result.gitArcFailure.conflicts[0], {
    overlaps: [{
      claimedPath: "webapp/components/workbench",
      requestedPath: "webapp/components/workbench/thread-view/ThreadView.tsx",
    }],
    owner: {
      checkpointCommit: "b".repeat(40),
      harness: "opencode",
      intentName: "change rendering",
      lifecycle: "completed",
      threadId: "owner-thread",
      title: "Render ownership",
    },
  });
});

test("missing arc refs return one typed message without unrelated recovery", async () => {
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: "Starting thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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

test("accepted proposal receipts remain structured when a resolved arc cannot continue", async () => {
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: "Resolved thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
  assert.match(result.error, /mcp__wbex__git_arc_plan_start/u);
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
      getThreadClaimContext: async () => null,
      refreshThreadGitArcState: async () => undefined,
      resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
    assert.match(result.error, /mcp__wbex__git_arc_/u);
    assert.doesNotMatch(result.error, /wb git arc/u);
  }
});

test("successful Git responses survive a failed thread claim refresh", async (context) => {
  const reported = context.mock.method(console, "error", () => undefined);
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => { throw new Error("projection exploded"); },
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => { refreshCount += 1; },
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => { refreshCount += 1; },
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
    getReloadScopesForPaths: () => ["server:mcp"],
    getThreadClaimContext: async () => null,
    refreshThreadGitArcState: async () => undefined,
    reloadScopeProjectRoot: "C:/Git/Project",
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
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
    paths: ["webapp/orchestrator/WorkbenchAgentMcpController.ts"],
    threadId: "thread-one",
  };
  const response = await feature.executeRequest(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    scopePaths: ["webapp/orchestrator/WorkbenchAgentMcpController.ts"],
  });
  assert.deepEqual(await feature.listReloadScopeClaims("C:/Git/Project"), []);
});

test("reloadable Git arc dispatch owns current-plan and proposal lifecycle actions", async () => {
  const calls: string[] = [];
  const feature = new WorkbenchGitArcFeature({
    getThreadClaimContext: async () => ({
      lifecycle: { kind: "completed", reason: "providerInactive", settled: false },
      title: "Thread",
    }),
    refreshThreadGitArcState: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd: "C:/Git/Project", project: { id: "project" } }),
    transitions: { run: async (_key, operation) => await operation() },
  });
  const internal = (feature as unknown as { controller: Record<string, (...args: never[]) => Promise<object>> }).controller;
  for (const method of ["createPlan", "addToPlan", "removeFromPlan", "adoptIntoPlan", "createAndStartPlan", "startArc", "rescindProposal", "diff", "createProposal"] as const) {
    internal[method] = async () => { calls.push(method); return {}; };
  }
  const common = { cwd: "C:/Git/Project", harness: "codex" as const, threadId: "thread-one" };
  const requests = [
    { action: "plan", intentDescription: "", intentName: "draft", paths: [], ...common },
    { action: "planAdd", paths: ["src/a.ts"], ...common },
    { action: "planRemove", paths: ["src/a.ts"], ...common },
    { action: "planAdopt", paths: ["src/dirty.ts"], ...common },
    { action: "planStart", intentDescription: "", intentName: "start", paths: ["src/a.ts"], ...common },
    { action: "arcStart", ...common },
    { action: "proposalRescind", proposalId: "proposal-one", ...common },
    { action: "diff", checkpointCommit: "abcdef1", paths: ["src/a.ts"], ...common },
    { action: "proposalCreate", amendProposalId: "proposal-one", description: "", title: "amend", ...common },
  ];
  const statuses = await Promise.all(requests.map(async (request) => (await feature.executeRequest(request)).status));
  assert.deepEqual(statuses, Array.from({ length: requests.length }, () => 200));
  assert.deepEqual([...calls].sort(), [
    "createPlan", "addToPlan", "removeFromPlan", "adoptIntoPlan", "createAndStartPlan", "startArc", "rescindProposal", "diff", "createProposal",
  ].sort());
});
