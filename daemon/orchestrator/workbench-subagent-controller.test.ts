/*
 * Exports:
 * - No production exports; Node tests cover profile listing, subagent creation/activity, direct-parent ownership, one-client lifecycle, and questionnaire delivery ordering.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { CodexJsonRpcResponse } from "workbench-shared/codex/protocol";
import type { WorkbenchComposerProfile, WorkbenchSubagentPage, WorkbenchSubagentRelationship, WorkbenchUserInputRequest } from "workbench-shared/types";
import { readWorkbenchAgentMessageItem } from "workbench-shared/workbench/thread/thread-agent-message";
import { readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import WorkbenchComposerProfileStore from "./WorkbenchComposerProfileStore";
import WorkbenchDatabaseController from "./database/WorkbenchDatabaseController";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

async function profileFixture(context: TestContext) {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-subagent-profiles-"));
  const database = new WorkbenchDatabaseController({ databasePath: path.join(storageRoot, "workbench.sqlite3") });
  const profileStore = new WorkbenchComposerProfileStore(storageRoot, database);
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
  assert.deepEqual(call.params.input, []);
  const item = readWorkbenchToolOutput({
    ...(call.params.toolOutput as object), id: "provider-output", type: "functionCallOutput",
  });
  assert.ok(item);
  return readWorkbenchAgentMessageItem(item);
}

const callerThreadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent-thread");
const childThreadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("child-thread");

function subagentFixture() {
  const database = createThreadStateTestDatabase();
  for (const id of [callerThreadId, childThreadId, "different-parent", "unrelated-thread"]) {
    database.admitThread("web/workbench", id);
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

function thread(id: string, cwd: string, status: "completed" | "inProgress" = "completed"): Thread {
  return {
    cwd,
    id,
    name: id,
    preview: "",
    source: "appServer",
    status: { type: status === "inProgress" ? "active" : "idle" },
    turns: [{ id: `${id}-turn`, items: [], status }],
    updatedAt: 1,
  } as Thread;
}

class FakeHarnessClient {
  readonly calls: HarnessCall[] = [];
  closeCount = 0;
  connectCount = 0;
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

  async connect() { this.connectCount += 1; }
  close() { this.closeCount += 1; }

  async sendRequest<T>(message: { method: string; params?: unknown } & Record<string, unknown>): Promise<CodexJsonRpcResponse<T>> {
    const harness = typeof message.workbenchHarness === "string" ? message.workbenchHarness : "codex";
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : {};
    const promptContext = message.workbenchPromptContext
      && typeof message.workbenchPromptContext === "object"
      && !Array.isArray(message.workbenchPromptContext)
      ? message.workbenchPromptContext as Record<string, unknown>
      : null;
    this.calls.push({ harness, method: message.method, params, promptContext });

    if (message.method === "thread/read") {
      if (harness !== "codex") return { error: { code: -32000, message: "Thread not found." }, id: 1 };
      const threadId = String(params.threadId ?? "");
      const result = { thread: thread(threadId, this.cwd, threadId === childThreadId ? this.childStatus : this.parentStatus) };
      return { id: 1, result: result as T };
    }
    if (message.method === "thread/start") return { id: 1, result: { thread: thread(childThreadId, this.cwd) } as T };
    if (message.method === "turn/start" && this.failTurnStart) return { error: { code: -32000, message: "Turn failed to start." }, id: 1 };
    if (message.method === "questionnaire/list") {
      return {
        id: 1,
        result: {
          data: [{ itemId: "item-1", request: questionnaire, requestKey: "request-key", threadId: childThreadId, turnId: `${childThreadId}-turn` }],
        } as T,
      };
    }
    return { id: 1, result: {} as T };
  }
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
    id: fixtureIdentitySchemas.ProjectIdSchema.parse("web/workbench"),
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

test("creates with one client and delivers native agent output before empty questionnaire resolution", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const clients: FakeHarnessClient[] = [];
  const committed: WorkbenchSubagentRelationship[] = [];
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    bridgeUrl: "ws://unused",
    createHarnessClient: () => {
      const client = new FakeHarnessClient(cwd);
      clients.push(client);
      return client;
    },
    onRelationshipCommitted: async (record) => {
      assert.equal(clients[0]?.calls.some(({ method }) => method === "turn/start"), false);
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
  assert.equal(clients.length, 1);
  assert.equal(clients[0].connectCount, 1);
  assert.equal(clients[0].closeCount, 1);
  assert.deepEqual(clients[0].calls.filter(({ method }) => method === "thread/start" || method === "turn/start").map(({ method }) => method), [
    "thread/start",
    "turn/start",
  ]);

  const threadStart = clients[0].calls.find(({ method }) => method === "thread/start");
  const turnStart = clients[0].calls.find(({ method }) => method === "turn/start");
  assert.equal(threadStart?.params.effort, "medium");
  assert.equal(turnStart?.params.effort, "medium");
  assert.equal(threadStart?.promptContext?.instructionScope, undefined);
  assert.deepEqual(turnStart?.promptContext, {
    ...threadStart?.promptContext,
    threadId: childThreadId,
  });
  assert.equal((turnStart?.params.collaborationMode as { settings?: { reasoning_effort?: string } })?.settings?.reasoning_effort, "medium");
  assert.equal((turnStart?.params.collaborationMode as { settings?: { developer_instructions?: string } })?.settings?.developer_instructions, "");
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

  const messaged = await controller.handleRequest({
    id: 5,
    method: "workbench/subagent/message",
    params: { callerThreadId, cwd, message: "Take the safer route.", threadId: childThreadId },
  });
  assert.deepEqual(messaged, { id: 5, result: {} });
  assert.equal(clients.length, 2);
  assert.equal(clients[1].connectCount, 1);
  assert.equal(clients[1].closeCount, 1);
  const lifecycleCalls = clients[1].calls.filter(({ method }) => method === "turn/start" || method === "questionnaire/respond");
  assert.deepEqual(lifecycleCalls.map(({ method }) => method), ["turn/start", "questionnaire/respond"]);
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
  assert.equal(clients.flatMap(({ calls }) => calls).filter(({ method }) => method === "thread/start").length, 1);
});

test("starts an idle direct parent through the pre-reload store surface", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const clients: FakeHarnessClient[] = [];
  const subagentStore = new WorkbenchSubagentStore(fixture.database);
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    bridgeUrl: "ws://unused",
    createHarnessClient: () => {
      const client = new FakeHarnessClient(cwd);
      clients.push(client);
      return client;
    },
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
  assert.deepEqual(
    clients[1].calls.filter(({ method }) => method === "thread/read").map(({ harness }) => harness),
    ["codex", "codex"],
  );
  const parentTurnStart = clients[1].calls.find(({ method, params }) => method === "turn/start" && params.threadId === callerThreadId);
  assert(parentTurnStart);
  assert.deepEqual(incomingAgentMessage(parentTurnStart), {
    message: "The safe route is ready.",
    senderName: "Mimi",
    senderThreadId: childThreadId,
  });
  assert.equal(clients[1].calls.some(({ method }) => method === "questionnaire/respond"), false);
});

test("starts an idle child with attributed input after its stored definition is deleted", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const clients: FakeHarnessClient[] = [];
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    bridgeUrl: "ws://unused",
    createHarnessClient: () => {
      const client = new FakeHarnessClient(cwd, false, "completed", "completed");
      clients.push(client);
      return client;
    },
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
  const childTurnStart = clients[1].calls.find(({ method, params }) => method === "turn/start" && params.threadId === childThreadId);
  assert(childTurnStart);
  assert.deepEqual(incomingAgentMessage(childTurnStart), {
    message: "Continue with the safe route.",
    senderName: "parent agent",
    senderThreadId: callerThreadId,
  });
});

test("delivers native output to an active direct parent and rejects callers without a relationship", async (context) => {
  const fixture = subagentFixture();
  const { storageRoot, profileStore } = await profileFixture(context);
  const cwd = process.cwd();
  const clients: FakeHarnessClient[] = [];
  const controller = new WorkbenchSubagentController({
    identities: fixture.identities,
    publicThreadId: fixture.publicThreadId,
    bridgeUrl: "ws://unused",
    createHarnessClient: () => {
      const client = new FakeHarnessClient(cwd, false, "inProgress");
      clients.push(client);
      return client;
    },
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
  const parentOutput = clients[1].calls.find(({ method, params }) => method === "turn/start" && params.threadId === callerThreadId);
  assert(parentOutput);
  assert.deepEqual(incomingAgentMessage(parentOutput), {
    message: "Active parent note.",
    senderName: "Mimi",
    senderThreadId: childThreadId,
  });
  assert.equal(clients[1].calls.some(({ method }) => method === "questionnaire/respond"), false);

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
    bridgeUrl: "ws://unused",
    createHarnessClient: () => new FakeHarnessClient(cwd),
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
    bridgeUrl: "ws://unused",
    createHarnessClient: () => new FakeHarnessClient(cwd, true),
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
