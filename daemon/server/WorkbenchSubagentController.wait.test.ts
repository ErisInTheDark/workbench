/*
 * Exports:
 * - No production exports; Node tests cover multiplexed subagent wait ordering, immediate readiness, and shared questionnaire reads.
 */
import assert from "node:assert/strict";
import { testProjectIds } from "workbench-shared/workbench/test-identities";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { ThreadPayload, WorkbenchSubagentRelationship, WorkbenchUserInputRequest } from "workbench-shared/types";
import type WorkbenchProvider from "./WorkbenchProvider";
import type { AgentEndpointProjectResolution } from "./lib/workbench/project/agent-endpoint-project";
import WorkbenchSubagentController from "./WorkbenchSubagentController";
import WorkbenchSubagentStore from "./WorkbenchSubagentStore";
import { createThreadStateTestDatabase } from "./workbench-thread-state-test-database";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

const callerThreadId = fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("parent-thread");
const inactiveThreadId = "inactive-child";
const questionnaireThreadId = "questionnaire-child";

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
    messageAgent: this.unused, rename: this.unused, compact: this.unused, interrupt: this.unused,
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
  const controller = new WorkbenchSubagentController({
    identities: database.identities.threads,
    publicThreadId: async (threadId, projectId) => {
      const identity = await database.identities.threads.resolve({ threadId, projectId });
      assert.ok(identity);
      return identity.threadId;
    },
    provider: () => client,
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
});
