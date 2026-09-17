/*
 * Exports:
 * - No production exports; tests protect profile selection, durable relationships, ownership and questionnaire delivery ordering.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { ThreadPayload, WorkbenchComposerProfile, WorkbenchSubagentPage, WorkbenchSubagentRelationship, WorkbenchUserInputRequest } from "workbench-shared/types";
import type WorkbenchProvider from "./WorkbenchProvider";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";

async function profileFixture(context: TestContext) {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-subagent-profiles-"));
  const database = new WorkbenchDatabaseController({ databasePath: path.join(storageRoot, "workbench.sqlite3") });
  const profileStore = new WorkbenchComposerProfileStore(database);
  context.after(async () => {
    await profileStore.dispose();
    await database.close();
    await rm(storageRoot, { force: true, recursive: true });
  });
  return { storageRoot, profileStore };
}

interface HarnessCall {
  harness: string;
  method: string;
  params: Record<string, unknown>;
  promptContext: Record<string, unknown> | null;
}

function incomingAgentMessage(call: HarnessCall | undefined) {
  assert.ok(call);
  return call.params.message;
}

const callerThreadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent-thread");
const childThreadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child-thread");

function subagentFixture() {
  const database = createThreadStateTestDatabase();
  for (const id of [callerThreadId, childThreadId, "different-parent", "unrelated-thread"]) {
    database.admitThread(testProjectIds.workbench, id);
  }
  return {
    database,
    identities: database.identities.threads,
    publicThreadId: async (threadId: fixtureIdentitySchemas.ThreadReference | fixtureIdentitySchemas.WorkbenchThreadId, projectId: fixtureIdentitySchemas.ProjectId) => {
      const identity = await database.identities.threads.resolve({ threadId, projectId });
      assert.ok(identity);
      return identity.threadId;
    },
  };
}
const questionnaire: WorkbenchUserInputRequest = {
  id: "questionnaire-1",
  questions: [{
    allowOther: true,
    header: "Direction",
    id: "direction",
    isSecret: false,
    options: [{ description: "Proceed.", label: "Continue" }],
    question: "Continue?",
  }],
  submitLabel: "Send",
  summary: "A decision is required.",
  title: "Direction",
};

function thread(id: string, cwd: string, status: "completed" | "inProgress" = "completed"): ThreadPayload {
  return {
    cwd,
    id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(id),
    harness: "codex",
    name: id,
    preview: "",
    source: "appServer",
    status: status === "inProgress" ? "active" : "idle",
    turns: [{ id: `${id}-turn`, items: [], itemsView: "full", status, completedAt: null, durationMs: null, startedAt: null, error: null }],
    updatedAt: 1,
    createdAt: 1, path: null, agentNickname: null, agentRole: null, isDraft: false,
    model: null, reasoningEffort: null, serviceTier: null, agentPath: null, tokenUsage: null, turnHistory: [],
  };
}

class FakeProvider {
  readonly calls: HarnessCall[] = [];
  private readonly cwd: string;
  private readonly childStatus: "completed" | "inProgress";
  private readonly failTurnStart: boolean;
  private readonly parentStatus: "completed" | "inProgress";

  constructor(
    cwd: string,
    failTurnStart = false,
    parentStatus: "completed" | "inProgress" = "completed",
    childStatus: "completed" | "inProgress" = "inProgress",
  ) {
    this.cwd = cwd;
    this.childStatus = childStatus;
    this.failTurnStart = failTurnStart;
    this.parentStatus = parentStatus;
  }

  private unused = async () => { throw new Error("Unexpected provider operation"); };
  private read = async (id: string) => {
    this.calls.push({ harness: "codex", method: "read", params: { threadId: id }, promptContext: null });
    return thread(id, this.cwd, id === childThreadId ? this.childStatus : this.parentStatus);
  };
  readonly threads: WorkbenchProvider["threads"] = {
    read: this.read, readLatest: this.read,
    latestTurn: async id => (await this.read(id)).turns.at(-1) ?? null,
    create: async input => {
      this.calls.push({ harness: "codex", method: "create", params: { ...input }, promptContext: input.context ?? null });
      return thread(childThreadId, this.cwd);
    },
    messageAgent: async input => {
      this.calls.push({ harness: "codex", method: "messageAgent", params: { ...input }, promptContext: input.context ?? null });
      if (this.failTurnStart) throw new Error("Turn failed to start.");
    },
    interrupt: async (threadId, turnId, options) => {
      assert.equal(options?.preserveGoal, true);
      this.calls.push({ harness: "codex", method: "interrupt", params: { threadId, turnId }, promptContext: null });
    },
    rename: async () => {}, list: this.unused, admitTurn: this.unused, page: this.unused,
    compact: this.unused, submit: this.unused, materialize: this.unused,
    history: { materialize: this.unused, questionnaires: this.unused, steers: this.unused, browse: this.unused },
  };
  readonly interactions: NonNullable<WorkbenchProvider["interactions"]> = {
    pending: async () => [{ harness: "codex", itemId: "item-1", request: questionnaire, requestKey: "request-key", threadId: childThreadId, turnId: `${childThreadId}-turn` }],
    respond: async input => {
      this.calls.push({ harness: "codex", method: "respond", params: { ...input }, promptContext: null });
      return {};
    },
    interruptRetaining: this.unused, canDeliver: this.unused, deliver: this.unused, supplement: this.unused, record: this.unused,
  };
}

function createPreReloadStoreSurface(store: WorkbenchSubagentStore) {
  return {
    getOwned: store.getOwned.bind(store),
    getOwnedMany: store.getOwnedMany.bind(store),
    list: store.list.bind(store),
    remove: store.remove.bind(store),
    replace: store.replace.bind(store),
    reserve: store.reserve.bind(store),
  };
}

function profile(): WorkbenchComposerProfile {
  return {
    agentPath: null,
    agentSource: null,
    createdAt: 1,
    description: "Use for difficult implementation work.\nAvoid for quick read-only searches.",
    harness: "codex",
    id: "lily-infinite",
    model: "gpt-5.4",
    name: "Lily INFINITE",
    reasoningEffort: "medium",
    scope: { kind: "global" },
    serviceTier: null,
    updatedAt: 1,
  };
}

function createProjectResolver(expectedCwd: string) {
  const cwd = path.resolve(expectedCwd);
  const root = {
    id: "workbench",
    name: "workbench",
    root: cwd,
    rootPath: cwd,
  };
  const project = {
    id: testProjectIds.workbench,
    kind: "git" as const,
    root: cwd,
    rootPath: cwd,
    roots: [root],
  };
  return async (requestedCwd: string | null | undefined) => {
    assert.equal(path.resolve(requestedCwd ?? ""), cwd);
    return { cwd, project, root };
  };
}

test("creates with the selected profile and delivers agent information before empty questionnaire resolution", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const provider = new FakeProvider(cwd);
  const committed: WorkbenchSubagentRelationship[] = [];
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    provider: () => provider,
    onRelationshipCommitted: async (record) => {
      assert.equal(provider.calls.some(({ method }) => method === "messageAgent"), false);
      committed.push(record);
    },
    resolveProjectFromCwd: createProjectResolver(cwd),
    profileStore,
    subagentStore: new WorkbenchSubagentStore(fixture.database),
  });

  await controller.mutateProfile({ kind: "upsert", profile: profile() });
  const profiles = await controller.handleRequest({ id: 2, method: "workbench/subagent/profiles", params: { cwd } });
  assert.deepEqual(profiles, { id: 2, result: { profiles: [profile()] } });
  const created = await controller.handleRequest({
    id: 3,
    method: "workbench/subagent/create",
    params: { callerThreadId, cwd, message: "Inspect the code.", name: "Mimi", profileId: profile().id, title: "Inspect code" },
  });
  assert.deepEqual(created, { id: 3, result: { threadId: childThreadId } });
  assert.deepEqual(committed.map(({ threadId }) => threadId), [childThreadId]);
  assert.deepEqual(provider.calls.filter(({ method }) => method === "create" || method === "messageAgent").map(({ method }) => method), [
    "create",
    "messageAgent",
  ]);

  const threadStart = provider.calls.find(({ method }) => method === "create");
  const turnStart = provider.calls.find(({ method }) => method === "messageAgent");
  assert.equal((threadStart?.params.profile as { settings: { reasoningEffort: string } }).settings.reasoningEffort, "medium");
  assert.deepEqual(turnStart?.promptContext, threadStart?.promptContext);
  assert.deepEqual(turnStart?.promptContext?.workflowIds, ["subagent"]);
  assert.deepEqual(incomingAgentMessage(turnStart), {
    message: "Inspect the code.",
    senderName: "parent agent",
    senderThreadId: callerThreadId,
  });
  const listedAfterCreate = await controller.handleRequest({
    id: 4,
    method: "workbench/subagent/list",
    params: { cwd, limit: 20, parentThreadId: callerThreadId },
  });
  assert.equal((listedAfterCreate.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "unknown");

  const previousCalls = provider.calls.length;
  const messaged = await controller.handleRequest({
    id: 5,
    method: "workbench/subagent/message",
    params: { callerThreadId, cwd, message: "Take the safer route.", threadId: childThreadId },
  });
  assert.deepEqual(messaged, { id: 5, result: {} });
  const lifecycleCalls = provider.calls.slice(previousCalls).filter(({ method }) => method === "messageAgent" || method === "respond");
  assert.deepEqual(lifecycleCalls.map(({ method }) => method), ["messageAgent", "respond"]);
  assert.deepEqual(incomingAgentMessage(lifecycleCalls[0]), {
    message: "Take the safer route.",
    senderName: "parent agent",
    senderThreadId: callerThreadId,
  });
  assert.deepEqual(lifecycleCalls[1].params.response, { answers: { direction: { answers: [] } } });

  const stopped = await controller.handleRequest({
    id: 6,
    method: "workbench/subagent/stop",
    params: { callerThreadId, cwd, threadId: childThreadId },
  });
  assert.deepEqual(stopped, { id: 6, result: {} });
  const listedAfterStop = await controller.handleRequest({
    id: 7,
    method: "workbench/subagent/list",
    params: { cwd, limit: 20, parentThreadId: callerThreadId },
  });
  assert.equal((listedAfterStop.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "unknown");

  const denied = await controller.handleRequest({
    id: 8,
    method: "workbench/subagent/stop",
    params: { callerThreadId: "different-parent", cwd, threadId: childThreadId },
  });
  assert.equal(denied.id, 8);
  assert.match(denied.error?.message ?? "", /owned by the current thread/u);

  const nestedCreate = await controller.handleRequest({
    id: 31,
    method: "workbench/subagent/create",
    params: { callerThreadId: childThreadId, cwd, message: "Create another child.", name: "Nana", profileId: profile().id, title: "Nested child" },
  });
  assert.match(nestedCreate.error?.message ?? "", /cannot create their own subagents/u);
  assert.equal(provider.calls.filter(({ method }) => method === "create").length, 1);
});

test("starts an idle direct parent through the pre-reload store surface", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const provider = new FakeProvider(cwd);
  const subagentStore = new WorkbenchSubagentStore(fixture.database);
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    provider: () => provider,
    onRelationshipCommitted: async () => undefined,
    resolveProjectFromCwd: createProjectResolver(cwd),
    profileStore,
    subagentStore: createPreReloadStoreSurface(subagentStore),
  });

  await controller.mutateProfile({ kind: "upsert", profile: profile() });
  assert.deepEqual(await controller.handleRequest({
    id: 2,
    method: "workbench/subagent/create",
    params: { callerThreadId, cwd, message: "Inspect the code.", name: "Mimi", profileId: profile().id, title: "Inspect code" },
  }), { id: 2, result: { threadId: childThreadId } });

  assert.deepEqual(await controller.handleRequest({
    id: 3,
    method: "workbench/subagent/message",
    params: { callerThreadId: childThreadId, cwd, message: "The safe route is ready.", parent: true },
  }), { id: 3, result: {} });
  const parentTurnStart = provider.calls.find(({ method, params }) => method === "messageAgent" && params.threadId === callerThreadId);
  assert(parentTurnStart);
  assert.deepEqual(incomingAgentMessage(parentTurnStart), {
    message: "The safe route is ready.",
    senderName: "Mimi",
    senderThreadId: childThreadId,
  });
  assert.equal(provider.calls.some(({ method }) => method === "respond"), false);
});

test("starts an idle child with attributed input after its stored definition is deleted", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const provider = new FakeProvider(cwd, false, "completed", "completed");
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    provider: () => provider,
    onRelationshipCommitted: async () => undefined,
    resolveProjectFromCwd: createProjectResolver(cwd),
    profileStore,
    subagentStore: new WorkbenchSubagentStore(fixture.database),
  });

  await controller.mutateProfile({ kind: "upsert", profile: profile() });
  assert.deepEqual(await controller.handleRequest({
    id: 2,
    method: "workbench/subagent/create",
    params: { callerThreadId, cwd, message: "Inspect the code.", name: "Mimi", profileId: profile().id, title: "Inspect code" },
  }), { id: 2, result: { threadId: childThreadId } });

  await controller.mutateProfile({ kind: "delete", profileId: profile().id });
  assert.deepEqual(await controller.handleRequest({
    id: 3,
    method: "workbench/subagent/message",
    params: { callerThreadId, cwd, message: "Continue with the safe route.", threadId: childThreadId },
  }), { id: 3, result: {} });
  const childTurnStart = provider.calls.findLast(({ method, params }) => method === "messageAgent" && params.threadId === childThreadId);
  assert(childTurnStart);
  assert.deepEqual(incomingAgentMessage(childTurnStart), {
    message: "Continue with the safe route.",
    senderName: "parent agent",
    senderThreadId: callerThreadId,
  });
});

test("delivers information to an active direct parent and rejects callers without a relationship", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const provider = new FakeProvider(cwd, false, "inProgress");
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    provider: () => provider,
    onRelationshipCommitted: async () => undefined,
    resolveProjectFromCwd: createProjectResolver(cwd),
    profileStore,
    subagentStore: new WorkbenchSubagentStore(fixture.database),
  });

  await controller.mutateProfile({ kind: "upsert", profile: profile() });
  assert.deepEqual(await controller.handleRequest({
    id: 2,
    method: "workbench/subagent/create",
    params: { callerThreadId, cwd, message: "Inspect the code.", name: "Mimi", profileId: profile().id, title: "Inspect code" },
  }), { id: 2, result: { threadId: childThreadId } });

  assert.deepEqual(await controller.handleRequest({
    id: 3,
    method: "workbench/subagent/message",
    params: { callerThreadId: childThreadId, cwd, message: "Active parent note.", parent: true },
  }), { id: 3, result: {} });
  const parentOutput = provider.calls.find(({ method, params }) => method === "messageAgent" && params.threadId === callerThreadId);
  assert(parentOutput);
  assert.deepEqual(incomingAgentMessage(parentOutput), {
    message: "Active parent note.",
    senderName: "Mimi",
    senderThreadId: childThreadId,
  });
  assert.equal(provider.calls.some(({ method }) => method === "respond"), false);

  const denied = await controller.handleRequest({
    id: 4,
    method: "workbench/subagent/message",
    params: { callerThreadId: "unrelated-thread", cwd, message: "Spoofed note.", parent: true },
  });
  assert.match(denied.error?.message ?? "", /not a Workbench subagent with a direct parent/u);
});

test("keeps relationship storage independent from lifecycle through create, message, and stop", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    provider: () => new FakeProvider(cwd),
    onRelationshipCommitted: async () => undefined,
    resolveProjectFromCwd: createProjectResolver(cwd),
    profileStore,
    subagentStore: new WorkbenchSubagentStore(fixture.database),
  });

  await controller.mutateProfile({ kind: "upsert", profile: profile() });
  const created = await controller.handleRequest({
    id: 2,
    method: "workbench/subagent/create",
    params: { callerThreadId, cwd, message: "Inspect the code.", name: "Mimi", profileId: profile().id, title: "Inspect code" },
  });
  assert.deepEqual(created, { id: 2, result: { threadId: childThreadId } });
  const listedAfterCreate = await controller.handleRequest({
    id: 3,
    method: "workbench/subagent/list",
    params: { cwd, limit: 20, parentThreadId: callerThreadId },
  });
  assert.equal((listedAfterCreate.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "unknown");

  assert.deepEqual(await controller.handleRequest({
    id: 4,
    method: "workbench/subagent/message",
    params: { callerThreadId, cwd, message: "Take the safer route.", threadId: childThreadId },
  }), { id: 4, result: {} });
  assert.deepEqual(await controller.handleRequest({
    id: 5,
    method: "workbench/subagent/stop",
    params: { callerThreadId, cwd, threadId: childThreadId },
  }), { id: 5, result: {} });
  const listedAfterStop = await controller.handleRequest({
    id: 6,
    method: "workbench/subagent/list",
    params: { cwd, limit: 20, parentThreadId: callerThreadId },
  });
  assert.equal((listedAfterStop.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "unknown");
});

test("keeps a created child durable when its first turn fails to start", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    provider: () => new FakeProvider(cwd, true),
    onRelationshipCommitted: async () => undefined,
    resolveProjectFromCwd: createProjectResolver(cwd),
    profileStore,
    subagentStore: new WorkbenchSubagentStore(fixture.database),
  });

  await controller.mutateProfile({ kind: "upsert", profile: profile() });
  const created = await controller.handleRequest({
    id: 2,
    method: "workbench/subagent/create",
    params: { callerThreadId, cwd, message: "Inspect the code.", name: "Poppy", profileId: profile().id, title: "Inspect code" },
  });
  assert.match(created.error?.message ?? "", /Turn failed to start.*subagent thread child-thread/u);

  const listed = await controller.handleRequest({
    id: 3,
    method: "workbench/subagent/list",
    params: { cwd, limit: 20, parentThreadId: callerThreadId },
  });
  assert.equal((listed.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "unknown");

  const stopped = await controller.handleRequest({
    id: 4,
    method: "workbench/subagent/stop",
    params: { callerThreadId, cwd, threadId: childThreadId },
  });
  assert.deepEqual(stopped, { id: 4, result: {} });
});
