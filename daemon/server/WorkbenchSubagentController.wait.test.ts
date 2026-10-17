/*
 * Exports:
 * - No production exports; protect subagent readiness, parent-message dependencies, subscription cleanup, and shared questionnaire reads.
 */
import assert from "node:assert/strict";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { ThreadPayload, WorkbenchPendingUserInputRequest, WorkbenchSubagentRelationship, WorkbenchUserInputRequest } from "workbench-shared/types";
import type WorkbenchProvider from "./WorkbenchProvider";
import type { AgentEndpointProjectResolution } from "./lib/workbench/project/agent-endpoint-project";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";
import type { WorkbenchThreadSidebarEntry } from "workbench-shared/workbench/thread/thread-state";
import WorkbenchMessageWaitController from "./WorkbenchMessageWaitController";

const callerThreadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent-thread");
const inactiveThreadId = "inactive-child";
const questionnaireThreadId = "questionnaire-child";

for (const order of ["child-first", "parent-first", "during-read", "cancel", "reload", "provider-only"] as const) {
  test(`parent wait observes its selected child's message dependency (${order})`, async context => {
    const cwd = process.cwd();
    const projectId = testProjectIds.independent;
    const childId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("waiting-child");
    const record = summary({ cwd, projectId, name: "mira", threadId: childId });
    const identity = (threadId: string) => ({
      threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId), projectId, projectRoot: cwd, bindings: [],
    });
    const messages = new WorkbenchMessageWaitController();
    const childAbort = new AbortController();
    let childWait: ReturnType<WorkbenchMessageWaitController["wait"]> | undefined;
    const startChild = () => childWait = messages.wait({
      waitId: "child-wait", callerThreadId: childId, senderThreadIds: [callerThreadId],
    }, childAbort.signal);
    const subscribed = Promise.withResolvers<void>();
    const reading = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    let stateListener: ((projectId: string, entry: WorkbenchThreadSidebarEntry) => void) | undefined;
    let reads = 0;
    let messageSubscriptions = 0;
    const controller = new WorkbenchSubagentController({
      identities: { resolve: async ({ threadId }) => identity(threadId), knownThread: identity },
      publicThreadId: async threadId => fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId),
      provider: () => { throw new Error("A waiting child has no completed turn to read."); },
      stopThread: async () => { throw new Error("Do not stop the child."); },
      onRelationshipCommitted: async () => {},
      resolveProjectFromCwd: async () => ({ cwd, project: { id: projectId }, root: {} }) as AgentEndpointProjectResolution,
      profileStore: { read: async () => ({ profiles: [] }), mutate: async () => ({ profiles: [] }) },
      subagentStore: {
        getOwnedMany: async () => [record],
        list: async () => ({ subagents: [record], nextCursor: null }),
        remove: async () => {}, replace: async () => {},
        reserve: async input => ({ ...input, directSubagentIndex: 0 }),
      },
      messageWaits: {
        isWaitingFor: (caller, sender) => messages.isWaitingFor(caller, sender),
        subscribePending: listener => {
          messageSubscriptions++;
          const unsubscribe = messages.subscribePending(listener);
          return () => { messageSubscriptions--; unsubscribe(); };
        },
      },
      threadState: order === "provider-only" ? undefined : {
        getEntry: async () => {
          if (++reads === 2 && order === "during-read") {
            reading.resolve();
            await releaseRead.promise;
          }
          return null;
        },
        mutate: async () => { throw new Error("Do not change lifecycle."); },
        subscribe: listener => {
          stateListener = listener;
          subscribed.resolve();
          return () => { stateListener = undefined; };
        },
      },
    });
    context.after(async () => {
      childAbort.abort();
      await childWait?.catch(() => undefined);
      messages.dispose();
      await controller.dispose();
    });
    if (order === "child-first" || order === "provider-only") startChild();
    const parentWait = controller.handleRequest({
      id: 1, method: "workbench/subagent/wait",
      params: { callerThreadId, cwd, threadIds: [childId], waitId: "parent-wait" },
    });
    if (order === "cancel" || order === "reload") {
      await subscribed.promise;
      if (order === "reload") controller.beginRuntimeDrain();
      else await controller.handleRequest({ id: 2, method: "workbench/subagent/waitCancel", params: { waitId: "parent-wait" } });
      assert.ok((await parentWait).error);
      assert.equal(stateListener, undefined);
      assert.equal(messageSubscriptions, 0);
      return;
    }
    if (order === "during-read") {
      await reading.promise;
      startChild();
      releaseRead.resolve();
    } else if (order === "parent-first") {
      await subscribed.promise;
      for (const [caller, sender] of [[childId, "sibling"], ["unselected-child", callerThreadId]]) {
        const unrelated = messages.wait({
          waitId: "unrelated", callerThreadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(caller!),
          senderThreadIds: [fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(sender!)],
        }, childAbort.signal);
        messages.receive(caller!, { senderThreadId: sender!, senderName: "other", message: "reply" });
        await unrelated;
        assert.equal(messageSubscriptions, 1, "unrelated dependencies must leave the parent's wait subscribed");
      }
      startChild();
    }
    // A terminal event makes a missing dependency wake fail promptly rather than hang the suite.
    if (order !== "parent-first") await Promise.race([subscribed.promise, parentWait]);
    stateListener?.(projectId, {
      ...record, entryKind: "subagent", identity: { harness: "codex", threadId: childId },
      activityAt: 1, pinned: false,
      lifecycle: { kind: "completed", reason: "agentCompleted", settled: false, agent: { agentStatus: "completed" } },
    });
    const result = await parentWait;
    assert.deepEqual(result, { id: 1, result: { output: "mira is waiting for a message from you." } });
    assert.equal(messages.isWaitingFor(childId, callerThreadId), true);
    assert.equal(stateListener, undefined);
    assert.equal(messageSubscriptions, 0);
    assert.deepEqual(await controller.handleRequest({
      id: 3, method: "workbench/subagent/wait",
      params: { callerThreadId, cwd, threadIds: [childId], waitId: "parent-again" },
    }), { id: 3, result: { output: "mira is waiting for a message from you." } });
    messages.receive(childId, { senderThreadId: callerThreadId, senderName: "parent", message: "continue" });
    assert.equal((await childWait)?.kind, "message");
  });
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

function thread(threadId: string, cwd: string, active: boolean): ThreadPayload {
  return {
    cwd,
    id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId),
    harness: "codex",
    name: threadId,
    preview: "",
    source: "appServer",
    status: active ? "active" : "idle",
    turns: [{
      id: `${threadId}-turn`,
      items: active ? [] : [{ id: "final", memoryCitation: null, phase: "final_answer", text: "Finished", type: "agentMessage", delivery: null, questions: null }],
      itemsView: "full",
      status: active ? "inProgress" : "completed",
      completedAt: null, durationMs: null, startedAt: null, error: null,
    }],
    updatedAt: 1,
    createdAt: 1, path: null, agentNickname: null, agentRole: null, isDraft: false,
    model: null, reasoningEffort: null, serviceTier: null, agentPath: null, tokenUsage: null, turnHistory: [],
  };
}

function summary({ cwd, name, projectId, threadId }: { cwd: string; name: string; projectId: string; threadId: string }): WorkbenchSubagentRelationship {
  return {
    createdAt: 1,
    cwd,
    directSubagentIndex: 0,
    harness: "codex",
    name,
    parentThreadId: callerThreadId,
    profileId: "profile-1",
    profileName: "Lily",
    projectId: fixtureIdentitySchemas.ProjectIdSchema.parse(projectId),
    threadId: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse(threadId),
    title: `${name} task`,
    updatedAt: 1,
  };
}

class FakeProvider {
  questionnaireVisible = true;
  questionnaireListCalls = 0;
  threadReadCalls = 0;
  readonly contentReads: string[] = [];
  private readonly cwd: string;

  constructor(cwd: string) { this.cwd = cwd; }
  private unused = async () => { throw new Error("unexpected provider operation"); };
  readonly threads: WorkbenchProvider["threads"] = {
    reconcile: async () => { throw new Error("Unexpected recovery"); },
    read: async threadId => {
      this.threadReadCalls++;
      return { ...thread(threadId, this.cwd, threadId === questionnaireThreadId), turns: [] };
    },
    readLatest: async threadId => {
      this.contentReads.push(threadId);
      return thread(threadId, this.cwd, threadId === questionnaireThreadId);
    },
    create: this.unused, list: this.unused, submit: this.unused,
    messageAgent: this.unused, rename: this.unused, compact: this.unused, interrupt: this.unused, isTurnLive: this.unused,
    latestTurn: this.unused, admitTurn: this.unused, materialize: this.unused,
    history: { materialize: this.unused },
  };
  readonly interactions: NonNullable<WorkbenchProvider["interactions"]> = {
    pending: async () => {
      this.questionnaireListCalls += 1;
      return this.questionnaireVisible ? [{
        harness: "codex",
        itemId: "item-1",
        request: questionnaire,
        requestKey: "request-key",
        threadId: questionnaireThreadId,
        turnId: `${questionnaireThreadId}-turn`,
      }] : [];
    },
    interruptRetaining: this.unused, canDeliver: this.unused, deliver: this.unused,
    respond: this.unused, supplement: this.unused, record: this.unused,
  };
}

test("multiplexed wait immediately prefers questionnaires, then inactive turns", async (context) => {
  const cwd = process.cwd();
  const projectId = testProjectIds.independent;
  const inactive = summary({ cwd, name: "Yuzu", projectId, threadId: inactiveThreadId });
  const waiting = summary({ cwd, name: "Momo", projectId, threadId: questionnaireThreadId });
  const database = createThreadStateTestDatabase();
  for (const threadId of [callerThreadId, inactiveThreadId, questionnaireThreadId]) database.admitThread(projectId, threadId);
  const subagentStore = new WorkbenchSubagentStore(database);
  for (const record of [inactive, waiting]) {
    const { threadId, directSubagentIndex: _index, ...metadata } = record;
    const reservationId = randomUUID();
    const reservation = await subagentStore.reserve({ ...metadata, reservationId });
    await subagentStore.replace(callerThreadId, reservationId, { ...record, directSubagentIndex: reservation.directSubagentIndex });
  }
  const client = new FakeProvider(cwd);
  let liveApprovals: WorkbenchPendingUserInputRequest[] = [];
  const controller = new WorkbenchSubagentController({
    liveApprovals: () => liveApprovals,
    identities: database.identities.threads,
    publicThreadId: async (threadId, projectId) => {
      const identity = await database.identities.threads.resolve({ threadId, projectId });
      assert.ok(identity);
      return identity.threadId;
    },
    provider: () => client,
    stopThread: async () => { throw new Error("Waits do not stop threads."); },
    onRelationshipCommitted: async () => undefined,
    resolveProjectFromCwd: async () => ({ cwd, project: { id: projectId }, root: {} }) as AgentEndpointProjectResolution,
    profileStore: { read: async () => ({ profiles: [] }), mutate: async () => ({ profiles: [] }) },
    subagentStore,
  });
  context.after(() => controller.dispose());
  const params = { callerThreadId, cwd, threadIds: [inactiveThreadId, questionnaireThreadId] };

  const questionnaireResult = await controller.handleRequest({
    id: 1,
    method: "workbench/subagent/wait",
    params: { ...params, waitId: "wait-1" },
  });
  assert.match(String((questionnaireResult.result as { output?: string } | undefined)?.output), /^Subagent Momo \(questionnaire-child\) needs interaction\./u);
  assert.equal(client.questionnaireListCalls, 1);
  assert.equal(client.threadReadCalls, 2);
  assert.deepEqual(client.contentReads, [questionnaireThreadId]);

  client.questionnaireVisible = false;
  const inactiveResult = await controller.handleRequest({
    id: 2,
    method: "workbench/subagent/wait",
    params: { ...params, waitId: "wait-2" },
  });
  assert.equal((inactiveResult.result as { output?: string } | undefined)?.output, "Subagent Yuzu (inactive-child) finished its current turn.\n\nFinished");
  assert.equal(client.questionnaireListCalls, 2);
  assert.equal(client.threadReadCalls, 4);
  assert.deepEqual(client.contentReads, [questionnaireThreadId, inactiveThreadId]);

  // Workbench owns live approvals outside the provider list; a child blocked on one still needs interaction.
  liveApprovals = [{
    harness: "codex", itemId: "item-2", request: { ...questionnaire, id: "approval-1" },
    requestKey: "approval-key", threadId: questionnaireThreadId, turnId: `${questionnaireThreadId}-turn`,
  }];
  const approvalResult = await controller.handleRequest({
    id: 3,
    method: "workbench/subagent/wait",
    params: { ...params, waitId: "wait-3" },
  });
  assert.match(String((approvalResult.result as { output?: string } | undefined)?.output), /^Subagent Momo \(questionnaire-child\) needs interaction\./u);
});
