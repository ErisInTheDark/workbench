/*
 * Exports: none. Tests protect subagent settle: a late terminal lifecycle is awaited,
 * a still-working child still errors at the deadline, a runtime drain aborts the wait,
 * and a refused mutation surfaces as failure instead of false success.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import * as identitySchemas from "workbench-shared/workbench/identity";
import type { JsonRpcResponse } from "./bridge-types";
import type { AgentEndpointProjectResolution } from "./lib/workbench/project/agent-endpoint-project";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";

const callerThreadId = identitySchemas.WorkbenchThreadIdSchema.parse("parent-thread");
const childThreadId = identitySchemas.WorkbenchThreadIdSchema.parse("child-thread");
const projectId = testProjectIds.independent;

type Lifecycle = { kind: "working" | "completed" | "stopped" };

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createHarness() {
  const cwd = process.cwd();
  const database = createThreadStateTestDatabase();
  database.admitThread(projectId, callerThreadId);
  database.admitThread(projectId, childThreadId);
  const subagentStore = new WorkbenchSubagentStore(database);
  const relationship: WorkbenchSubagentRelationship = {
    createdAt: 1,
    cwd,
    directSubagentIndex: 0,
    harness: "codex",
    name: "Yuzu",
    parentThreadId: callerThreadId,
    profileId: "profile-1",
    profileName: "Lily",
    projectId,
    threadId: childThreadId,
    title: "Yuzu task",
    updatedAt: 1,
  };
  const { threadId: _threadId, directSubagentIndex: _directSubagentIndex, ...metadata } = relationship;
  const reservationId = randomUUID();
  const reservation = await subagentStore.reserve({ ...metadata, reservationId });
  await subagentStore.replace(callerThreadId, reservationId, {
    ...relationship,
    directSubagentIndex: reservation.directSubagentIndex,
  });

  let gitArc: unknown = null;
  let lifecycle: Lifecycle = { kind: "working" };
  let refuseMutation = false;
  const mutations: Array<Record<string, unknown>> = [];
  const controller = new WorkbenchSubagentController({
    identities: database.identities.threads,
    publicThreadId: async () => { throw new Error("Settle does not publish thread identities."); },
    provider: () => { throw new Error("Settle does not call providers."); },
    stopThread: async () => { throw new Error("Settle does not stop threads."); },
    onRelationshipCommitted: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd, project: { id: projectId }, root: {} }) as AgentEndpointProjectResolution,
    profileStore: { read: async () => ({ profiles: [] }), mutate: async () => ({ profiles: [] }) },
    subagentStore,
    threadState: {
      getEntry: async () => ({ entryKind: "subagent", gitArc, pinned: false, lifecycle }) as never,
      mutate: async (request) => {
        mutations.push(request as unknown as Record<string, unknown>);
        return { accepted: !refuseMutation };
      },
      subscribe: () => () => undefined,
    },
  });
  return {
    controller,
    mutations,
    setGitArc: (next: unknown) => { gitArc = next; },
    setLifecycle: (next: Lifecycle) => { lifecycle = next; },
    setRefuseMutation: (next: boolean) => { refuseMutation = next; },
    settle: (): Promise<JsonRpcResponse> => controller.handleRequest({
      id: 1,
      method: "workbench/subagent/settle",
      params: { callerThreadId, cwd, threadIds: [childThreadId] },
    }),
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
  assert.deepEqual(response.result, { settled: [{ name: "Yuzu", threadId: childThreadId }] });
  assert.equal(harness.mutations.length, 1);
  assert.equal(harness.mutations[0]?.method, "workbench/thread-state/settle");
});

test("settle still errors when the child never reaches a terminal lifecycle", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  let outcome: JsonRpcResponse | null = null;
  const pending = harness.settle();
  void pending.then((response) => { outcome = response; });
  await flush();

  assert.equal(outcome, null, "settle must wait rather than error immediately");
  context.mock.timers.tick(30_000);

  const response = await pending;
  assert.match(response.error?.message ?? "", /can be settled only after it is Completed or Stopped/u);
  assert.deepEqual(harness.mutations, []);
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

test("a refused mutation surfaces failure instead of false success", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const harness = await createHarness();
  context.after(() => harness.controller.dispose());
  harness.setLifecycle({ kind: "completed" });
  harness.setGitArc({ claimedPaths: ["src/a.ts"], phase: "active" });
  harness.setRefuseMutation(true);

  const response = await harness.settle();
  assert.match(response.error?.message ?? "", /still holds live Git arc claims and cannot be settled/u);
  assert.equal(response.result, undefined);
  assert.equal(harness.mutations.length, 1);
});
