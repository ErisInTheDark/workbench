/* Exports: none. Protect profiles, durable relationships, ownership, parent stop and questionnaire delivery. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import WorkbenchTemporaryDirectory from "workbench-shared/WorkbenchTemporaryDirectory";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { ThreadPayload, WorkbenchComposerProfile, WorkbenchSubagentPage, WorkbenchSubagentRelationship, WorkbenchUserInputRequest } from "workbench-shared/types";
import type WorkbenchProvider from "../providers/WorkbenchProvider";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import WorkbenchComposerProfileStore from "../store/WorkbenchComposerProfileStore";
import WorkbenchDatabaseController from "../database/WorkbenchDatabaseController";
import { createThreadStateTestDatabase } from "../thread/workbench-thread-state-test-database";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import type { WorkbenchThreadStateRecord } from "../thread/workbench-thread-state-record";

async function profileFixture(context: TestContext) {
  const temporary = await WorkbenchTemporaryDirectory.create("workbench-subagent-profiles-");
  const storageRoot = temporary.path;
  const database = new WorkbenchDatabaseController({ databasePath: path.join(storageRoot, "workbench.sqlite3") });
  const profileStore = new WorkbenchComposerProfileStore(database);
  context.after(async () => {
    await profileStore.dispose();
    await database.close();
    await temporary.dispose();
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
    reconcile: async () => { throw new Error("Unexpected recovery"); },
    read: this.read, readLatest: this.read,
    latestTurn: async id => (await this.read(id)).turns.at(-1) ?? null,
    create: async input => {
      this.calls.push({ harness: "codex", method: "create", params: { ...input }, promptContext: input.context ?? null });
      return thread(childThreadId, this.cwd);
    },
    messageAgent: async input => {
      this.calls.push({ harness: "codex", method: "messageAgent", params: { ...input }, promptContext: input.context ?? null });
      if (this.failTurnStart) throw new Error("Turn failed to start.");
      return { kind: "started", turnId: `${input.threadId}-admitted` };
    },
    interrupt: async threadId => {
      this.calls.push({ harness: "codex", method: "interrupt", params: { threadId }, promptContext: null });
    },
    rename: async () => {}, list: this.unused, admitTurn: this.unused,
    compact: this.unused, submit: this.unused, materialize: this.unused, isTurnLive: this.unused,
    history: { materialize: this.unused },
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

test("older children remain listable and name-addressable before settled history is paginated", async (context) => {
  const fixture = subagentFixture();
  const cwd = process.cwd();
  const provider = new FakeProvider(cwd);
  const store = new WorkbenchSubagentStore(fixture.database);
  const historicalId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("unrelated-thread");
  const { reservationId, ...reserved } = await store.reserve({
    reservationId: randomUUID(), parentThreadId: callerThreadId, projectId: testProjectIds.workbench,
    harness: "codex", cwd, name: "Mimi", title: "Previous work", profileId: profile().id,
    profileName: profile().name, createdAt: 1, updatedAt: 1,
  });
  const historical = { ...reserved, threadId: historicalId };
  await store.replace(callerThreadId, reservationId, historical);
  const writeState = (record: WorkbenchSubagentRelationship, settled: boolean) => {
    const state: WorkbenchThreadStateRecord = {
      ...record, entryKind: "subagent", identity: { harness: record.harness, threadId: record.threadId },
      activityAt: 1, pinned: false, lifecycle: { kind: "completed", reason: "agentCompleted", settled, agent: { agentStatus: "completed" } },
      profile: null, providerObserved: true, settledAt: settled ? 2 : null,
      gitHistoryCleanedAt: null, mcpGeneration: null,
    };
    fixture.database.admitRecord(state);
    fixture.database.repository.writeRecords([state]);
  };
  writeState(historical, false);
  const settledIds = [historicalId];
  for (let index = 0; index < 25; index++) {
    const threadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(`settled-child-${index}`);
    fixture.database.admitThread(testProjectIds.workbench, threadId);
    const { reservationId: id, ...metadata } = await store.reserve({
      ...reserved, reservationId: randomUUID(), name: `settled-${index}`, createdAt: index + 2,
    });
    const record = { ...metadata, threadId };
    await store.replace(callerThreadId, id, record);
    writeState(record, true);
    settledIds.push(threadId);
  }
  const stopped: string[] = [];
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities, publicThreadId: fixture.publicThreadId, provider: () => provider,
    onRelationshipCommitted: async record => { writeState(record, false); },
    resolveProjectFromCwd: createProjectResolver(cwd), subagentStore: store,
    profileStore: {
      read: async () => ({ profiles: [profile()] }),
      mutate: async () => { throw new Error("Unexpected profile mutation"); },
    },
    stopThread: async id => { stopped.push(id); },
    threadState: {
      getEntry: async (projectId, _harness, threadId) =>
        fixture.database.repository.readRecords({ selection: "threads", threadIds: [threadId], projectId })[0] ?? null,
      mutate: async () => { throw new Error("Unexpected state mutation"); },
      subscribe: () => () => {},
    },
  });
  context.after(() => controller.dispose());
  const create = () => controller.handleRequest({
    id: 1, method: "workbench/subagent/create",
    params: { callerThreadId, cwd, name: "mimi", title: "New work", profileId: profile().id,
      message: "Inspect the code.", userVisibleSimpleVersion: "Asked Mimi to inspect the code." },
  });
  const listed = await controller.handleRequest({
    id: 2, method: "workbench/subagent/list", params: { callerThreadId, cwd },
  });
  assert.deepEqual((listed.result as WorkbenchSubagentPage).subagents.map(record => record.threadId), [historicalId]);
  assert.match((await create()).error?.message ?? "", /unsettled direct child/i);
  const stopByName = () => controller.handleRequest({
    id: 3, method: "workbench/subagent/stop", params: { callerThreadId, cwd, names: ["MIMI"] },
  });
  assert.equal((await stopByName()).error, undefined);
  assert.deepEqual(stopped, [historicalId]);
  writeState(historical, true);
  assert.deepEqual(await create(), { id: 1, result: { threadId: childThreadId } });
  assert.match((await create()).error?.message ?? "", /unsettled direct child/i);
  assert.equal((await stopByName()).error, undefined);
  assert.deepEqual(stopped, [historicalId, childThreadId]);
  const readHistory = async (cursor?: string) => {
    const result = await controller.handleRequest({
      id: 4, method: "workbench/subagent/list", params: { callerThreadId, cwd, settled: true, cursor },
    });
    assert.equal(result.error, undefined);
    return result.result as WorkbenchSubagentPage;
  };
  const first = await readHistory();
  assert.equal(first.subagents.length, 20);
  assert.ok(first.nextCursor);
  const second = await readHistory(first.nextCursor);
  assert.equal(second.subagents.length, 6);
  assert.equal(second.nextCursor, null);
  const historyIds = [...first.subagents, ...second.subagents].map(record => record.threadId);
  assert.equal(new Set(historyIds).size, historyIds.length);
  assert.deepEqual(new Set(historyIds), new Set(settledIds));
});

test("creates with the selected profile and delivers attributed initial input", async (context) => {
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
    stopThread: async () => undefined,
  });

  await controller.mutateProfile({ kind: "upsert", profile: profile() });
  const profiles = await controller.handleRequest({ id: 2, method: "workbench/subagent/profiles", params: { cwd } });
  assert.deepEqual(profiles, { id: 2, result: { profiles: [profile()] } });
  const created = await controller.handleRequest({
    id: 3,
    method: "workbench/subagent/create",
    params: {
      callerThreadId,
      cwd,
      message: "Inspect the code.",
      name: "Mimi",
      profileId: profile().id,
      title: "Inspect code",
      userVisibleSimpleVersion: "Asked Mimi to inspect the code.",
    },
  });
  assert.deepEqual(created, { id: 3, result: { threadId: childThreadId } });
  assert.deepEqual(committed.map(({ threadId }) => threadId), [childThreadId]);
  // A wait right after creation must see the first message's turn as running, not the empty thread as finished.
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
    userVisibleSimpleVersion: "Asked Mimi to inspect the code.",
  });
  const listedAfterCreate = await controller.handleRequest({
    id: 4,
    method: "workbench/subagent/list",
    params: { cwd, limit: 20, parentThreadId: callerThreadId },
  });
  assert.equal((listedAfterCreate.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "unknown");

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

test("keeps relationship storage independent from lifecycle through create and stop", async (context) => {
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
    stopThread: async () => undefined,
  });

  await controller.mutateProfile({ kind: "upsert", profile: profile() });
  const created = await controller.handleRequest({
    id: 2,
    method: "workbench/subagent/create",
    params: {
      callerThreadId,
      cwd,
      message: "Inspect the code.",
      name: "Mimi",
      profileId: profile().id,
      title: "Inspect code",
      userVisibleSimpleVersion: "Asked Mimi to inspect the code.",
    },
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
    method: "workbench/subagent/stop",
    params: { callerThreadId, cwd, threadId: childThreadId },
  }), { id: 4, result: {} });
  const listedAfterStop = await controller.handleRequest({
    id: 5,
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
    stopThread: async () => undefined,
  });

  await controller.mutateProfile({ kind: "upsert", profile: profile() });
  const created = await controller.handleRequest({
    id: 2,
    method: "workbench/subagent/create",
    params: {
      callerThreadId,
      cwd,
      message: "Inspect the code.",
      name: "Poppy",
      profileId: profile().id,
      title: "Inspect code",
      userVisibleSimpleVersion: "Asked Poppy to inspect the code.",
    },
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
