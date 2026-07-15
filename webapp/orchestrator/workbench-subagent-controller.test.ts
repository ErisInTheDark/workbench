/*
 * Exports:
 * - No production exports; Node tests cover profile listing, subagent creation/activity, direct-parent ownership, one-client lifecycle, and questionnaire steer ordering. Keywords: subagent, profile, controller, activity, authorization, questionnaire, test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type { CodexJsonRpcResponse } from "../lib/codex/protocol";
import type { WorkbenchComposerProfile, WorkbenchSubagentPage, WorkbenchUserInputRequest } from "../lib/types";
import { readWorkbenchSubagentMessageInput } from "../lib/workbench/thread/thread-subagent-message";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";

interface HarnessCall {
  harness: string;
  method: string;
  params: Record<string, unknown>;
}

const callerThreadId = "parent-thread";
const childThreadId = "child-thread";
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
  private readonly failTurnStart: boolean;
  private readonly parentStatus: "completed" | "inProgress";

  constructor(cwd: string, failTurnStart = false, parentStatus: "completed" | "inProgress" = "completed") {
    this.cwd = cwd;
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
    this.calls.push({ harness, method: message.method, params });

    if (message.method === "thread/read") {
      if (harness !== "codex") return { error: { code: -32000, message: "Thread not found." }, id: 1 };
      const threadId = String(params.threadId ?? "");
      const result = { thread: thread(threadId, this.cwd, threadId === childThreadId ? "inProgress" : this.parentStatus) };
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
    markActivity: store.markActivity.bind(store),
    remove: store.remove.bind(store),
    replace: store.replace.bind(store),
    reserve: store.reserve.bind(store),
  };
}

function profile(): WorkbenchComposerProfile {
  return {
    agentPath: "agent://lily.md",
    agentSource: "library",
    createdAt: 1,
    description: "Use for difficult implementation work.\nAvoid for quick read-only searches.",
    harness: "codex",
    id: "lily-infinite",
    model: "gpt-5.4",
    name: "Lily INFINITE",
    reasoningEffort: "high",
    scope: { kind: "global" },
    serviceTier: null,
    updatedAt: 1,
  };
}

test("creates with one client and delivers a steer before empty questionnaire resolution", async (context) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-subagent-controller-"));
  context.after(async () => await rm(storageRoot, { force: true, recursive: true }));
  const cwd = process.cwd();
  const clients: FakeHarnessClient[] = [];
  const controller = new WorkbenchSubagentController({
    bridgeUrl: "ws://unused",
    createHarnessClient: () => {
      const client = new FakeHarnessClient(cwd);
      clients.push(client);
      return client;
    },
    storageRoot,
  });

  await controller.handleRequest({ id: 1, method: "workbench/composerProfiles/importLegacy", params: { profiles: [profile()] } });
  const profiles = await controller.handleRequest({ id: 2, method: "workbench/subagent/profiles", params: { cwd } });
  assert.deepEqual(profiles, { id: 2, result: { profiles: [profile()] } });
  const created = await controller.handleRequest({
    id: 3,
    method: "workbench/subagent/create",
    params: { callerThreadId, cwd, message: "Inspect the code.", name: "Mimi", profileId: profile().id, title: "Inspect code" },
  });
  assert.deepEqual(created, { id: 3, result: { threadId: childThreadId } });
  assert.equal(clients.length, 1);
  assert.equal(clients[0].connectCount, 1);
  assert.equal(clients[0].closeCount, 1);
  assert.deepEqual(clients[0].calls.filter(({ method }) => method === "thread/start" || method === "turn/start").map(({ method }) => method), [
    "thread/start",
    "turn/start",
  ]);
  const listedAfterCreate = await controller.handleRequest({
    id: 4,
    method: "workbench/subagent/list",
    params: { cwd, limit: 20, parentThreadId: callerThreadId },
  });
  assert.equal((listedAfterCreate.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "active");

  const messaged = await controller.handleRequest({
    id: 5,
    method: "workbench/subagent/message",
    params: { callerThreadId, cwd, message: "Take the safer route.", threadId: childThreadId },
  });
  assert.deepEqual(messaged, { id: 5, result: {} });
  assert.equal(clients.length, 2);
  assert.equal(clients[1].connectCount, 1);
  assert.equal(clients[1].closeCount, 1);
  const lifecycleCalls = clients[1].calls.filter(({ method }) => method === "turn/steer" || method === "questionnaire/respond");
  assert.deepEqual(lifecycleCalls.map(({ method }) => method), ["turn/steer", "questionnaire/respond"]);
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
  assert.equal((listedAfterStop.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "inactive");

  const denied = await controller.handleRequest({
    id: 8,
    method: "workbench/subagent/stop",
    params: { callerThreadId: "different-parent", cwd, threadId: childThreadId },
  });
  assert.equal(denied.id, 8);
  assert.match(denied.error?.message ?? "", /not owned by the current thread/u);
});

test("starts an idle direct parent through the pre-reload store surface", async (context) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-subagent-controller-idle-parent-message-"));
  context.after(async () => await rm(storageRoot, { force: true, recursive: true }));
  const cwd = process.cwd();
  const clients: FakeHarnessClient[] = [];
  const subagentStore = new WorkbenchSubagentStore(storageRoot);
  const controller = new WorkbenchSubagentController({
    bridgeUrl: "ws://unused",
    createHarnessClient: () => {
      const client = new FakeHarnessClient(cwd);
      clients.push(client);
      return client;
    },
    storageRoot,
    subagentStore: createPreReloadStoreSurface(subagentStore),
  });

  await controller.handleRequest({ id: 1, method: "workbench/composerProfiles/importLegacy", params: { profiles: [profile()] } });
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
  assert.deepEqual(readWorkbenchSubagentMessageInput(parentTurnStart.params.input as UserInput[]), {
    message: "The safe route is ready.",
    name: "Mimi",
    threadId: childThreadId,
  });
  assert.equal(clients[1].calls.some(({ method }) => method === "questionnaire/respond"), false);
});

test("steers an active direct parent and rejects callers without a relationship", async (context) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-subagent-controller-parent-message-"));
  context.after(async () => await rm(storageRoot, { force: true, recursive: true }));
  const cwd = process.cwd();
  const clients: FakeHarnessClient[] = [];
  const controller = new WorkbenchSubagentController({
    bridgeUrl: "ws://unused",
    createHarnessClient: () => {
      const client = new FakeHarnessClient(cwd, false, "inProgress");
      clients.push(client);
      return client;
    },
    storageRoot,
  });

  await controller.handleRequest({ id: 1, method: "workbench/composerProfiles/importLegacy", params: { profiles: [profile()] } });
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
  const parentSteer = clients[1].calls.find(({ method, params }) => method === "turn/steer" && params.threadId === callerThreadId);
  assert(parentSteer);
  assert.deepEqual(readWorkbenchSubagentMessageInput(parentSteer.params.input as UserInput[]), {
    message: "Active parent note.",
    name: "Mimi",
    threadId: childThreadId,
  });
  assert.equal(clients[1].calls.some(({ method }) => method === "questionnaire/respond"), false);

  const denied = await controller.handleRequest({
    id: 4,
    method: "workbench/subagent/message",
    params: { callerThreadId: "unrelated-thread", cwd, message: "Spoofed note.", parent: true },
  });
  assert.match(denied.error?.message ?? "", /not a Workbench subagent with a direct parent/u);
});

test("tracks durable activity through create, message, and stop", async (context) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-subagent-controller-activity-"));
  context.after(async () => await rm(storageRoot, { force: true, recursive: true }));
  const cwd = process.cwd();
  const controller = new WorkbenchSubagentController({
    bridgeUrl: "ws://unused",
    createHarnessClient: () => new FakeHarnessClient(cwd),
    storageRoot,
  });

  await controller.handleRequest({ id: 1, method: "workbench/composerProfiles/importLegacy", params: { profiles: [profile()] } });
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
  assert.equal((listedAfterCreate.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "active");

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
  assert.equal((listedAfterStop.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "inactive");
});

test("keeps a created child durable when its first turn fails to start", async (context) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-subagent-controller-partial-"));
  context.after(async () => await rm(storageRoot, { force: true, recursive: true }));
  const cwd = process.cwd();
  const controller = new WorkbenchSubagentController({
    bridgeUrl: "ws://unused",
    createHarnessClient: () => new FakeHarnessClient(cwd, true),
    storageRoot,
  });

  await controller.handleRequest({ id: 1, method: "workbench/composerProfiles/importLegacy", params: { profiles: [profile()] } });
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
  assert.equal((listed.result as WorkbenchSubagentPage).subagents[0]?.activityStatus, "inactive");

  const stopped = await controller.handleRequest({
    id: 4,
    method: "workbench/subagent/stop",
    params: { callerThreadId, cwd, threadId: childThreadId },
  });
  assert.deepEqual(stopped, { id: 4, result: {} });
});
