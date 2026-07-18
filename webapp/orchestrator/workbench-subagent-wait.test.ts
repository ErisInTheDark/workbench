/*
 * Exports:
 * - No production exports; Node tests cover multiplexed subagent wait ordering, immediate readiness, and shared questionnaire reads. Keywords: subagent, wait, multiplex, questionnaire, test.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { CodexJsonRpcResponse } from "../lib/codex/protocol";
import type { WorkbenchSubagentRelationship, WorkbenchUserInputRequest } from "../lib/types";
import { resolveAgentEndpointProjectFromCwd } from "../lib/workbench/project/agent-endpoint-project";
import WorkbenchSubagentController from "./WorkbenchSubagentController";

const callerThreadId = "parent-thread";
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
    activityStatus: "inactive",
    createdAt: 1,
    cwd,
    directSubagentIndex: 0,
    harness: "codex",
    lastActivityAt: 1,
    name,
    parentThreadId: callerThreadId,
    profileId: "profile-1",
    profileName: "Lily",
    projectId,
    threadId,
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
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "workbench-subagent-wait-"));
  context.after(async () => await rm(storageRoot, { force: true, recursive: true }));
  const cwd = process.cwd();
  const project = await resolveAgentEndpointProjectFromCwd(cwd, { endpointName: "Workbench subagent wait test" });
  const inactive = summary({ cwd, name: "Yuzu", projectId: project.project.id, threadId: inactiveThreadId });
  const waiting = summary({ cwd, name: "Momo", projectId: project.project.id, threadId: questionnaireThreadId });
  const metadataPath = path.join(storageRoot, ".workbench", "runtime", "subagents.json");
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataPath, JSON.stringify({
    subagents: { [inactiveThreadId]: inactive, [questionnaireThreadId]: waiting },
    version: 1,
  }), "utf8");
  const client = new FakeHarnessClient(cwd);
  const controller = new WorkbenchSubagentController({
    bridgeUrl: "ws://unused",
    createHarnessClient: () => client,
    storageRoot,
  });
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
