/*
 * Exports: none. Tests protect subagent settle: a late terminal lifecycle is awaited, a still-working child is
 * reported at the deadline, a runtime drain aborts the wait, every selected child gets its own outcome, refused
 * mutations name held claims, stash, required todos or addressed feedback, and handover moves Git work and todos
 * before settling while a refused adoption leaves the child untouched.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import * as identitySchemas from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSettlementHold } from "workbench-shared/workbench/thread/thread-state";
import type { JsonRpcResponse } from "./bridge-types";
import type { AgentEndpointProjectResolution } from "./lib/workbench/project/agent-endpoint-project";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";

const callerThreadId = identitySchemas.WorkbenchThreadIdSchema.parse("parent-thread");
const childThreadId = identitySchemas.WorkbenchThreadIdSchema.parse("child-thread");
const secondThreadId = identitySchemas.WorkbenchThreadIdSchema.parse("second-child-thread");
const projectId = testProjectIds.independent;

type Lifecycle = { kind: "working" | "completed" | "stopped" };
interface ChildState {
  gitArc: unknown;
  hold: WorkbenchThreadSettlementHold | null;
  lifecycle: Lifecycle;
  refuseMutation: boolean;
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createHarness() {
  const cwd = process.cwd();
  const database = createThreadStateTestDatabase();
  database.admitThread(projectId, callerThreadId);
  const subagentStore = new WorkbenchSubagentStore(database);
  const children = new Map<string, ChildState>();
  for (const [threadId, name] of [[childThreadId, "Yuzu"], [secondThreadId, "Mochi"]] as const) {
    database.admitThread(projectId, threadId);
    const relationship: WorkbenchSubagentRelationship = {
      createdAt: 1, cwd, directSubagentIndex: 0, harness: "codex", name, parentThreadId: callerThreadId,
      profileId: "profile-1", profileName: "Lily", projectId, threadId, title: `${name} task`, updatedAt: 1,
    };
    const { threadId: _threadId, directSubagentIndex: _directSubagentIndex, ...metadata } = relationship;
    const reservationId = randomUUID();
    const reservation = await subagentStore.reserve({ ...metadata, reservationId });
    await subagentStore.replace(callerThreadId, reservationId, { ...relationship, directSubagentIndex: reservation.directSubagentIndex });
    children.set(threadId, { gitArc: null, hold: null, lifecycle: { kind: "working" }, refuseMutation: false });
  }
  const child = (threadId: string = childThreadId) => children.get(threadId)!;
  const mutations: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  let adoptionFailure: string | null = null;
  const adoptions: Array<Record<string, unknown>> = [];
  const controller = new WorkbenchSubagentController({
    identities: database.identities.threads,
    settlementHold: async (threadId) => child(threadId).hold,
    adoptChildGitWork: async (input) => {
      adoptions.push(input);
      events.push(`adopt:${input.name}`);
      if (adoptionFailure) throw new Error(adoptionFailure);
      const threadId = input.name === "Yuzu" ? childThreadId : secondThreadId;
      child(threadId).gitArc = null;
    },
    moveTodos: async (from, to) => {
      events.push(`todos:${from}->${to}`);
      if (child(from).hold === "requiredTodos") child(from).hold = null;
      return [4, 5];
    },
    publicThreadId: async () => { throw new Error("Settle does not publish thread identities."); },
    provider: () => { throw new Error("Settle does not call providers."); },
    stopThread: async () => { throw new Error("Settle does not stop threads."); },
    onRelationshipCommitted: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd, project: { id: projectId }, root: {} }) as AgentEndpointProjectResolution,
    profileStore: { read: async () => ({ profiles: [] }), mutate: async () => ({ profiles: [] }) },
    subagentStore,
    threadState: {
      getEntry: async (_project, _harness, threadId) => {
        const state = child(threadId);
        return { entryKind: "subagent", gitArc: state.gitArc, pinned: false, lifecycle: state.lifecycle } as never;
      },
      mutate: async (request) => {
        mutations.push(request as unknown as Record<string, unknown>);
        const threadId = (request as { identity: { threadId: string } }).identity.threadId;
        events.push(`settle:${threadId}`);
        const state = child(threadId);
        return { accepted: !state.refuseMutation && !state.hold && !state.gitArc };
      },
      subscribe: () => () => undefined,
    },
  });
  const settle = (threadIds: string[] = [childThreadId], extra: Record<string, unknown> = {}): Promise<JsonRpcResponse> => controller.handleRequest({
    id: 1, method: "workbench/subagent/settle", params: { callerThreadId, cwd, threadIds, ...extra },
  });
  return {
    adoptions, child, controller, events, mutations, settle,
    handover: (threadIds: string[] = [childThreadId]) => settle(threadIds, { handover: true, callerHarness: "claude" }),
    setAdoptionFailure: (message: string | null) => { adoptionFailure = message; },
    setGitArc: (next: unknown, threadId?: string) => { child(threadId).gitArc = next; },
    setLifecycle: (next: Lifecycle, threadId?: string) => { child(threadId).lifecycle = next; },
    setRefuseMutation: (next: boolean, threadId?: string) => { child(threadId).refuseMutation = next; },
    setSettlementHold: (next: WorkbenchThreadSettlementHold | null, threadId?: string) => { child(threadId).hold = next; },
  };
}

test("settle waits for a late terminal lifecycle before mutating", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  let outcome: JsonRpcResponse | null = null;
  const pending = harness.settle();
  void pending.then((response) => { outcome = response; });
  await flush();

  assert.equal(outcome, null, "settle must not resolve before the child is terminal");
  harness.setLifecycle({ kind: "completed" });
  context.mock.timers.tick(1_000);

  const response = await pending;
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, { settled: [{ name: "Yuzu", threadId: childThreadId }], blocked: [] });
  assert.equal(harness.mutations.length, 1);
  assert.equal(harness.mutations[0]?.method, "workbench/thread-state/settle");
});

test("a child still working at the deadline is reported while its terminal sibling settles", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  harness.setLifecycle({ kind: "completed" }, secondThreadId);
  let outcome: JsonRpcResponse | null = null;
  const pending = harness.settle([childThreadId, secondThreadId]);
  void pending.then((response) => { outcome = response; });
  await flush();

  assert.equal(outcome, null, "settle must wait rather than error immediately");
  context.mock.timers.tick(30_000);

  const response = await pending;
  assert.match(response.error?.message ?? "", /Not settled Yuzu \(child-thread\): can be settled only after it is Completed or Stopped/u);
  assert.match(response.error?.message ?? "", /Settled Mochi \(second-child-thread\)\./u);
  assert.deepEqual(harness.mutations.map(({ identity }) => (identity as { threadId: string }).threadId), [secondThreadId]);
});

test("a runtime drain aborts a pending settle wait", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  let outcome: JsonRpcResponse | null = null;
  const pending = harness.settle();
  void pending.then((response) => { outcome = response; });
  await flush();

  assert.equal(outcome, null, "settle must wait rather than abort immediately");
  harness.controller.beginRuntimeDrain();
  context.mock.timers.tick(1_000);

  const response = await pending;
  assert.match(response.error?.message ?? "", /draining for runtime reload/u);
  assert.deepEqual(harness.mutations, []);
});

test("every selected child is attempted and the receipt names each outcome", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  harness.setLifecycle({ kind: "completed" });
  harness.setLifecycle({ kind: "stopped" }, secondThreadId);
  harness.setGitArc({ claimedPaths: ["src/a.ts"], phase: "active" });

  const response = await harness.settle([childThreadId, secondThreadId]);
  const message = response.error?.message ?? "";
  assert.match(message, /Not settled Yuzu \(child-thread\): still holds live Git arc claims and cannot be settled\./u);
  assert.match(message, /Settled Mochi \(second-child-thread\)\./u, "a blocked child must not hide a sibling that did settle");
  assert.equal(harness.mutations.length, 2);
});

test("a settle held by thread-owned work names what holds it", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  harness.setLifecycle({ kind: "completed" });

  harness.setGitArc({ claimedPaths: [], stashedPaths: ["src/a.ts"], phase: "active" });
  assert.match((await harness.settle()).error?.message ?? "", /still holds a saved Git arc stash and cannot be settled/u);
  harness.setGitArc(null);

  harness.setSettlementHold("requiredTodos");
  const todos = await harness.settle();
  assert.match(todos.error?.message ?? "", /still holds required todos and cannot be settled/u);
  assert.equal(todos.result, undefined);

  harness.setSettlementHold("addressedFeedback");
  const feedback = await harness.settle();
  assert.match(feedback.error?.message ?? "", /still addresses feedback that is not resolved or detached and cannot be settled/u);
});

test("handover adopts Git work with its stash, then moves todos, then settles", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  harness.setLifecycle({ kind: "stopped" });
  harness.setGitArc({ claimedPaths: ["src/a.ts", "src/b.ts"], stashedPaths: ["src/c.ts"], phase: "active" });
  harness.setSettlementHold("requiredTodos");

  const response = await harness.handover();
  assert.equal(response.error, undefined);
  assert.deepEqual(harness.events, ["adopt:Yuzu", `todos:${childThreadId}->${callerThreadId}`, `settle:${childThreadId}`]);
  assert.deepEqual(harness.adoptions, [{
    cwd: process.cwd(), harness: "claude", name: "Yuzu", parentThreadId: callerThreadId, transferStash: true,
  }]);
  assert.deepEqual(response.result, {
    settled: [{ name: "Yuzu", threadId: childThreadId, handover: { claimCount: 2, stashedPathCount: 1, todoIds: [4, 5] } }],
    blocked: [],
  });
});

test("handover without Git work only moves todos and never asks for a stash transfer", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  harness.setLifecycle({ kind: "completed" });

  const response = await harness.handover();
  assert.equal(response.error, undefined);
  assert.deepEqual(harness.adoptions, []);
  assert.deepEqual(harness.events, [`todos:${childThreadId}->${callerThreadId}`, `settle:${childThreadId}`]);
});

test("handover leaves a child held by addressed feedback untouched", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  harness.setLifecycle({ kind: "completed" });
  harness.setGitArc({ claimedPaths: ["src/a.ts"], phase: "active" });
  harness.setSettlementHold("addressedFeedback");

  const response = await harness.handover();
  assert.match(response.error?.message ?? "", /Not settled Yuzu \(child-thread\): still addresses feedback/u);
  assert.deepEqual(harness.events, [], "no Git work or todos move for a child that still cannot settle");
});

test("a refused handover adoption leaves the child's todos and settlement untouched", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  harness.setLifecycle({ kind: "stopped" });
  harness.setLifecycle({ kind: "completed" }, secondThreadId);
  harness.setGitArc({ claimedPaths: ["src/a.ts"], stashedPaths: ["src/c.ts"], phase: "active" });
  harness.setAdoptionFailure("Saved stash cannot move to a thread with its own pending stack layers.");

  const response = await harness.handover([childThreadId, secondThreadId]);
  const message = response.error?.message ?? "";
  assert.match(message, /Not settled Yuzu \(child-thread\): handover failed: Saved stash cannot move to a thread with its own pending stack layers\. Adopt it with discardStash/u);
  assert.match(message, /Settled Mochi \(second-child-thread\) with handover: moved todos 4, 5 to you\./u);
  assert.deepEqual(harness.events, ["adopt:Yuzu", `todos:${secondThreadId}->${callerThreadId}`, `settle:${secondThreadId}`]);
});
