/*
 * No production exports. Tests protect direct provider thread, turn, and item projection without storage reads. Keywords: codex, transcript, provider, test.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import {
  createCodexTurnTokenUsageObservation,
  createCodexTurnTokenUsageObservationFromNotification,
  createCodexTurnUsageContextObservation,
  createCodexTranscriptProviderDynamicToolObservation,
  createCodexTranscriptProviderItemObservation,
  createCodexTranscriptProviderThreadScopeObservation,
  createCodexTranscriptProviderThreadObservation,
  createCodexTranscriptProviderThreadObservations,
  createCodexTranscriptProviderTurnScopeObservation,
} from "./codex-transcript-provider-observations.ts";

const context = {
  activityAt: 6_000,
  createdAt: 1_000,
  nativeLocation: "C:/repo",
  projectId: "project",
  projectRoot: "C:/repo",
  title: "Thread",
  updatedAt: 6_000,
};

function providerThread(): Thread {
  return {
    agentNickname: null,
    agentRole: null,
    canAcceptDirectInput: null,
    cliVersion: "test",
    createdAt: 1,
    cwd: "C:/repo",
    ephemeral: false,
    extra: null,
    forkedFromId: null,
    gitInfo: null,
    historyMode: "legacy",
    id: "thread",
    modelProvider: "openai",
    name: "Thread",
    parentThreadId: null,
    path: null,
    preview: "",
    recencyAt: null,
    section: null,
    sectionEnteredAt: null,
    sessionId: "session",
    source: "appServer",
    status: { type: "idle" },
    threadSource: null,
    turns: [{
      completedAt: 6,
      durationMs: 5_000,
      error: null,
      id: "turn",
      items: [{
        id: "answer",
        memoryCitation: null,
        phase: "final_answer",
        text: "done",
        type: "agentMessage",
      }],
      itemsView: "full",
      startedAt: 1,
      status: "completed",
    }],
    updatedAt: 6,
  };
}

test("routine provider metadata projects without importing turns", () => {
  assert.deepEqual(createCodexTranscriptProviderThreadObservation("thread", context), {
    activityAt: 6_000,
    createdAt: 1_000,
    kind: "thread",
    projectId: "project",
    projectRoot: "C:/repo",
    threadId: "thread",
    title: "Thread",
    updatedAt: 6_000,
  });
});

test("turn usage helpers preserve explicit turn identity and final token categories", () => {
  assert.deepEqual(createCodexTurnUsageContextObservation({
    model: "gpt-5.4",
    observedAt: 10,
    serviceTier: "fast",
    threadId: "thread",
    turnId: "turn",
  }), {
    kind: "turnUsageContext",
    model: "gpt-5.4",
    observedAt: 10,
    serviceTier: "fast",
    threadId: "thread",
    turnId: "turn",
  });
  assert.deepEqual(createCodexTurnTokenUsageObservation({
    observedAt: 20,
    threadId: "thread",
    turnId: "turn",
    usage: {
      cacheWriteInputTokens: 5,
      cachedInputTokens: 20,
      inputTokens: 100,
      outputTokens: 40,
      reasoningOutputTokens: 10,
      totalTokens: 140,
    },
  }), {
    cumulative: {
      cacheWriteInputTokens: 5,
      cachedInputTokens: 20,
      inputTokens: 100,
      outputTokens: 40,
      reasoningOutputTokens: 10,
      totalTokens: 140,
    },
    kind: "turnTokenUsage",
    observedAt: 20,
    threadId: "thread",
    turnId: "turn",
    usageDataVersion: 2,
  });
});

test("Codex accounting observations use cumulative totals instead of the active context snapshot", () => {
  assert.deepEqual(createCodexTurnTokenUsageObservationFromNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread",
      tokenUsage: {
        last: {
          cacheWriteInputTokens: 5,
          cachedInputTokens: 20,
          inputTokens: 100,
          outputTokens: 40,
          reasoningOutputTokens: 10,
          totalTokens: 140,
        },
        modelContextWindow: 200_000,
        total: {
          cacheWriteInputTokens: 50,
          cachedInputTokens: 2_000,
          inputTokens: 10_000,
          outputTokens: 4_000,
          reasoningOutputTokens: 1_000,
          totalTokens: 14_000,
        },
      },
      turnId: "turn",
    },
  }, 20), {
    cumulative: {
      cacheWriteInputTokens: 50,
      cachedInputTokens: 2_000,
      inputTokens: 10_000,
      outputTokens: 4_000,
      reasoningOutputTokens: 1_000,
      totalTokens: 14_000,
    },
    kind: "turnTokenUsage",
    observedAt: 20,
    threadId: "thread",
    turnId: "turn",
    usageDataVersion: 2,
  });
});

test("one provider snapshot becomes direct ordered thread, turn, and item facts", () => {
  const observations = createCodexTranscriptProviderThreadObservations(providerThread(), context);
  assert.deepEqual(observations.map(({ kind }) => kind), ["thread", "turn", "item"]);
  assert.deepEqual(observations[1], {
    createdAt: 1_000,
    durationMs: 5_000,
    endedAt: 6_000,
    harnessId: "codex",
    kind: "turn",
    nativeLocation: "C:/repo",
    nativeThreadId: "thread",
    nativeTurnId: "turn",
    startedAt: 1_000,
    state: "completed",
    threadId: "thread",
    turnId: "turn",
    turnIndex: 0,
  });
  assert.equal(observations[2]?.kind === "item" ? observations[2].timeline : null, undefined);
});

test("complete provider snapshots keep carried items with their first turn", () => {
  const thread = providerThread();
  const carried = thread.turns[0]!.items[0]!;
  thread.turns.push({
    completedAt: 9,
    durationMs: 2_000,
    error: null,
    id: "later",
    items: [
      carried,
      { id: "later-answer", memoryCitation: null, phase: "final_answer", text: "later", type: "agentMessage" },
    ],
    itemsView: "full",
    startedAt: 7,
    status: "completed",
  });

  const observations = createCodexTranscriptProviderThreadObservations(thread, context);
  assert.deepEqual(
    observations
      .filter((observation) => observation.kind === "item")
      .map(({ item, turnId }) => [turnId, item.id]),
    [["turn", "answer"], ["later", "later-answer"]],
  );
});

test("complete provider scopes normalize positional snapshot aliases before admission", () => {
  const thread = providerThread();
  const userContent = [{ text: "hello", text_elements: [], type: "text" as const }];
  const reasoningSummary = ["thinking"];
  thread.turns[0]!.items = [
    { clientId: null, content: userContent, id: "user-canonical", type: "userMessage" },
    { clientId: null, content: userContent, id: "item-1", type: "userMessage" },
    { content: [], id: "rs-canonical", summary: reasoningSummary, type: "reasoning" },
    { content: [], id: "item-2", summary: reasoningSummary, type: "reasoning" },
    thread.turns[0]!.items[0]!,
  ];

  const scope = createCodexTranscriptProviderThreadScopeObservation(thread, context);
  assert.deepEqual(scope.completeTurnIds, ["turn"]);
  assert.deepEqual(
    scope.observations
      .filter((observation) => observation.kind === "item")
      .map(({ item }) => item.id),
    ["user-canonical", "rs-canonical", "answer"],
  );
});

test("one completed provider turn becomes one normalized replacement scope", () => {
  const turn = providerThread().turns[0]!;
  const scope = createCodexTranscriptProviderTurnScopeObservation({
    context,
    threadId: "thread",
    turn,
  });
  assert.equal(scope.kind, "providerTurnScope");
  assert.deepEqual(scope.completeTurnIds, ["turn"]);
  assert.deepEqual(scope.observations.map(({ kind }) => kind), ["turn", "item"]);
});

test("one provider item lifecycle becomes one atomic observation", () => {
  const item = {
    id: "answer",
    memoryCitation: null,
    phase: "commentary" as const,
    text: "streaming",
    type: "agentMessage" as const,
  };
  assert.deepEqual(createCodexTranscriptProviderItemObservation({
    item,
    lifecycle: "streaming",
    observedAt: 2_000,
    threadId: "thread",
    turnId: "turn",
  }), {
    item,
    kind: "item",
    lifecycle: "streaming",
    observedAt: 2_000,
    threadId: "thread",
    turnId: "turn",
  });
});

test("provider item lifecycle timestamps remain direct durable facts", () => {
  const item = {
    id: "answer",
    memoryCitation: null,
    phase: "commentary" as const,
    text: "done",
    type: "agentMessage" as const,
  };
  const observation = createCodexTranscriptProviderItemObservation({
    completedAtMs: 2_000,
    item,
    lifecycle: "completed",
    observedAt: 2_100,
    startedAtMs: 1_000,
    threadId: "thread",
    turnId: "turn",
  });
  assert.deepEqual(observation.timeline, {
    completedAt: 2_000,
    firstSeenAt: 1_000,
    itemId: "answer",
    lastSeenAt: 2_000,
    startedAt: 1_000,
  });
});

test("one provider dynamic-tool request becomes one direct operation item", () => {
  const observation = createCodexTranscriptProviderDynamicToolObservation({
    id: 10,
    method: "item/tool/call",
    params: {
      arguments: { query: "hello" },
      callId: "call",
      namespace: "demo",
      threadId: "thread",
      tool: "search",
      turnId: "turn",
    },
  }, 3_000);
  assert.equal(observation?.kind, "item");
  assert.equal(observation?.item.id, "call");
  assert.equal(observation?.item.type, "dynamicToolCall");
  assert.equal(observation?.timeline?.startedAt, 3_000);
});
