/*
 * No production exports. Tests protect daemon-owned questionnaire response routing, delivery fencing, and settlement order.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import WorkbenchQuestionnaireResponseController, {
  type WorkbenchQuestionnaireResponseStatePort,
} from "./WorkbenchQuestionnaireResponseController";
import {
  NativeThreadIdSchema,
  NativeTurnIdSchema,
  ProjectIdSchema,
  WorkbenchThreadIdSchema,
  WorkbenchTurnIdSchema,
} from "workbench-shared/workbench/identity";
import type {
  WorkbenchQuestionnaireHistoryEntryState,
  WorkbenchThreadLifecycle,
} from "workbench-shared/workbench/thread/thread-state";

const projectId = ProjectIdSchema.parse("project");
const threadId = WorkbenchThreadIdSchema.parse("thread");
const nativeThreadId = NativeThreadIdSchema.parse("native-thread");
const turnId = WorkbenchTurnIdSchema.parse("turn");
const response = { answers: { route: { answers: ["approve"] } } };
const questionnaire = {
  itemId: "item",
  request: {
    id: "request",
    questions: [{
      allowOther: false,
      header: "route",
      id: "route",
      isSecret: false,
      options: [{ description: "continue", label: "approve" }],
      question: "continue?",
    }],
    submitLabel: "submit",
    summary: "",
    title: "questionnaire",
  },
  requestKey: "workbench-mcp:question",
  turnId,
};

function createHistoryEntry(): WorkbenchQuestionnaireHistoryEntryState {
  return {
    ...questionnaire,
    insertAfterItemId: null,
    insertAfterItemIndex: null,
    resolvedAt: 10,
    response,
    threadId,
  };
}

function createHarness(lifecycle: WorkbenchThreadLifecycle, options: {
  admissionError?: string;
  deliverable?: boolean;
  requestKey?: string;
} = {}) {
  const events: string[] = [];
  const requests: JsonRpcRequest[] = [];
  let settled = false;
  let pendingRequestKey: string | null = options.requestKey ?? questionnaire.requestKey;
  let stateQueue = Promise.resolve();
  const state: WorkbenchQuestionnaireResponseStatePort = {
    resolvePendingQuestionnaire: async (input, deliver) => {
      const previous = stateQueue;
      let release = () => {};
      stateQueue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        if (pendingRequestKey !== input.requestKey) return null;
        const historyEntry = createHistoryEntry();
        const delivery = await deliver({ historyEntry, lifecycle, questionnaire });
        events.push("settled");
        pendingRequestKey = null;
        settled = true;
        return { delivery, historyEntry };
      } finally {
        release();
      }
    },
  };
  const controller = new WorkbenchQuestionnaireResponseController({
    harnesses: {
      request: async (_harness, request): Promise<JsonRpcResponse> => {
        requests.push(request);
        events.push(request.method);
        if (request.method === "workbench/codex/message/admit" && options.admissionError) {
          return { id: request.id ?? null, error: { code: -32000, message: options.admissionError } };
        }
        return { id: request.id ?? null, result: { ok: true } };
      },
      resolvePublicRequest: async (_harness, request) => ({
        harness: "codex",
        request: {
          ...request,
          params: {
            ...(request.params as Record<string, unknown>),
            threadId: nativeThreadId,
          },
        },
      }),
      resolveThreadIdentity: async () => ({
        bindings: [{
          harness: "codex",
          nativeLocation: "C:/project",
          nativeThreadId,
          pending: false,
          turnIndex: 0,
        }],
        projectId,
        projectRoot: "C:/project",
        threadId,
      }),
    },
    questionnaires: {
      canDeliver: () => options.deliverable ?? true,
      deliver: async () => {
        events.push("waiter");
        return { ...questionnaire, response, threadId: nativeThreadId, turnId: NativeTurnIdSchema.parse("native-turn") };
      },
    },
    state,
  });
  return { controller, events, requests, settled: () => settled };
}

function request() {
  return {
    activatedSkillPaths: ["C:/skills/review/SKILL.md"],
    harness: "codex" as const,
    projectId,
    requestKey: questionnaire.requestKey,
    response,
    supplementalInput: [{ text: "extra context", text_elements: [], type: "text" as const }],
    threadId,
    turnId,
  };
}

test("terminal lifecycle admits even when the daemon still exposes an orphan waiter", async () => {
  const harness = createHarness({
    agent: { agentStatus: "blocked", turnId },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  });

  const result = await harness.controller.respond(request());

  assert.equal(result.route, "admitted");
  assert.equal(harness.events.includes("waiter"), false);
  assert.deepEqual(harness.events.slice(0, 2), ["workbench/codex/message/admit", "settled"]);
  const admission = harness.requests.find(({ method }) => method === "workbench/codex/message/admit");
  const startRequest = (admission?.params as { startRequest?: JsonRpcRequest } | undefined)?.startRequest;
  assert.deepEqual((startRequest?.params as { input?: unknown[] } | undefined)?.input?.slice(1), request().supplementalInput);
  assert.deepEqual(
    (startRequest as { workbenchPromptContext?: { activatedSkillPaths?: string[] } } | undefined)?.workbenchPromptContext?.activatedSkillPaths,
    request().activatedSkillPaths,
  );
  assert.equal(harness.settled(), true);
});

test("matching pending-input lifecycle resolves its live waiter before settlement", async () => {
  const harness = createHarness({
    kind: "needsAttention",
    reason: "pendingInput",
    requestKey: questionnaire.requestKey,
    settled: false,
    turnId,
  });

  const result = await harness.controller.respond({ ...request(), activatedSkillPaths: undefined, supplementalInput: undefined });

  assert.equal(result.route, "live");
  assert.deepEqual(harness.events, ["waiter", "settled", "questionnaire/history/record"]);
  assert.equal(harness.requests.some(({ method }) => method === "workbench/codex/message/admit"), false);
});

test("failed detached admission leaves durable settlement untouched", async () => {
  const harness = createHarness({
    agent: { agentStatus: "blocked", turnId },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  }, { admissionError: "admission failed" });

  await assert.rejects(harness.controller.respond(request()), /admission failed/u);

  assert.equal(harness.settled(), false);
  assert.deepEqual(harness.events, ["workbench/codex/message/admit"]);
});

test("a replaced request key cannot deliver or settle the old answer", async () => {
  const harness = createHarness({
    agent: { agentStatus: "blocked", turnId },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  }, { requestKey: "workbench-mcp:replacement" });

  await assert.rejects(harness.controller.respond(request()), /no longer pending/u);

  assert.equal(harness.settled(), false);
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.requests, []);
});

test("concurrent duplicate answers admit and settle exactly once", async () => {
  const harness = createHarness({
    agent: { agentStatus: "blocked", turnId },
    kind: "needsAttention",
    reason: "agentBlocked",
    settled: false,
  });

  const results = await Promise.allSettled([
    harness.controller.respond(request()),
    harness.controller.respond(request()),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(harness.requests.filter(({ method }) => method === "workbench/codex/message/admit").length, 1);
  assert.equal(harness.requests.filter(({ method }) => method === "questionnaire/history/record").length, 1);
  assert.deepEqual(harness.events.slice(0, 2), ["workbench/codex/message/admit", "settled"]);
});
