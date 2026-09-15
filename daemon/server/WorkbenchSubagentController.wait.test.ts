/*
 * Exports:
 * - No production exports; Node tests cover multiplexed subagent wait ordering, immediate readiness, and shared questionnaire reads.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { CodexJsonRpcResponse } from "workbench-shared/codex/protocol";
import type { WorkbenchSubagentRelationship, WorkbenchUserInputRequest } from "workbench-shared/types";
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

function thread(threadId: string, cwd: string, active: boolean): Thread {
  return {
    cwd,
    id: threadId,
    name: threadId,
    preview: "",
    source: "appServer",
    status: { type: active ? "active" : "idle" },
    turns: [{
      id: `${threadId}-turn`,
      items: active ? [] : [{ id: "final", memoryCitation: null, phase: "final_answer", text: "Finished", type: "agentMessage" }],
      status: active ? "inProgress" : "completed",
    }],
    updatedAt: 1,
  } as Thread;
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

class FakeHarnessClient {
  questionnaireVisible = true;
  questionnaireListCalls = 0;
  threadReadCalls = 0;
  private readonly cwd: string;

  constructor(cwd: string) { this.cwd = cwd; }
  async connect() {}
  close() {}

  async sendRequest<T>(message: { method: string; params?: unknown }): Promise<CodexJsonRpcResponse<T>> {
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : {};
    if (message.method === "thread/read") {
      this.threadReadCalls += 1;
      const threadId = String(params.threadId ?? "");
      return { id: 1, result: { thread: thread(threadId, this.cwd, threadId === questionnaireThreadId) } as T };
    }
    if (message.method === "questionnaire/list") {
      this.questionnaireListCalls += 1;
      return { id: 1, result: { data: this.questionnaireVisible ? [{
        itemId: "item-1",
        request: questionnaire,
        requestKey: "request-key",
        threadId: questionnaireThreadId,
        turnId: `${questionnaireThreadId}-turn`,
      }] : [] } as T };
    }
    return { id: 1, result: {} as T };
  }
}

test("multiplexed wait immediately prefers questionnaires, then inactive turns", async (context) => {
  const cwd = process.cwd();
  const projectId = "local:///subagent-wait-project";
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
  const client = new FakeHarnessClient(cwd);
  const controller = new WorkbenchSubagentController({
    identities: database.identities.threads,
    publicThreadId: async (threadId, projectId) => {
      const identity = await database.identities.threads.resolve({ threadId, projectId });
      assert.ok(identity);
      return identity.threadId;
    },
    bridgeUrl: "ws://unused",
    createHarnessClient: () => client,
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

  client.questionnaireVisible = false;
  const inactiveResult = await controller.handleRequest({
    id: 2,
    method: "workbench/subagent/wait",
    params: { ...params, waitId: "wait-2" },
  });
  assert.equal((inactiveResult.result as { output?: string } | undefined)?.output, "Subagent Yuzu (inactive-child) finished its current turn.\n\nFinished");
  assert.equal(client.questionnaireListCalls, 2);
  assert.equal(client.threadReadCalls, 4);
});
