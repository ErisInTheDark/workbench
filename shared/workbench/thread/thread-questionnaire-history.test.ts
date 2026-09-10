/*
 * No production exports. Tests protect native Workbench request identity and permanent questionnaire item identity when provider keys repeat across turns.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem.ts";
import type { Turn } from "../../codex/generated/app-server/v2/Turn.ts";
import type { ThreadPayload, WorkbenchQuestionnaireHistoryEntry } from "../../types.ts";
import { findWorkbenchThreadItemTimelineEntry } from "./thread-item-timeline.ts";
import {
  applyQuestionnaireHistoryToThread,
  isSyntheticQuestionnaireHistoryItem,
} from "./thread-questionnaire-history.ts";
import {
  isWorkbenchMcpQuestionnaireRequestKey,
  mergeQuestionnaireHistoryEntries,
  resolveQuestionnaireHistoryItemId,
} from "./thread-questionnaire-identity.ts";
import * as fixtureIdentitySchemas from "workbench-shared/workbench/identity";

test("Workbench MCP questionnaire keys keep a strict native-response namespace", () => {
  assert.equal(isWorkbenchMcpQuestionnaireRequestKey("workbench-mcp:question"), true);
  assert.equal(isWorkbenchMcpQuestionnaireRequestKey("workbench-mcpish:question"), false);
  assert.equal(isWorkbenchMcpQuestionnaireRequestKey("provider-question"), false);
});

function turn(id: string, item: ThreadItem): Turn {
  return {
    completedAt: 2,
    durationMs: 1_000,
    error: null,
    id,
    items: [item],
    itemsView: "full",
    startedAt: 1,
    status: "completed",
  };
}

function entry(turnId: string, itemId: string | null): WorkbenchQuestionnaireHistoryEntry {
  return {
    insertAfterItemId: `anchor-${turnId}`,
    insertAfterItemIndex: 0,
    itemId,
    request: {
      id: `request-${turnId}`,
      questions: [{
        allowOther: false,
        header: "Pick",
        id: "choice",
        isSecret: false,
        options: [],
        question: "Which?",
      }],
      submitLabel: "Submit",
      summary: "Choose",
      title: "Question",
    },
    requestKey: "reused-request-key",
    resolvedAt: turnId === "older" ? 2_000 : 4_000,
    response: { answers: { choice: { answers: ["one"] } } },
    threadId: "thread",
    turnId,
  };
}

function thread(): ThreadPayload {
  const turns = ["older", "newer"].map((turnId) => turn(turnId, {
    id: `anchor-${turnId}`,
    memoryCitation: null,
    delivery: null,
    questions: null,
    phase: "commentary",
    text: turnId,
    type: "agentMessage",
  }));
  return {
    agentNickname: null,
    agentPath: null,
    agentRole: null,
    browseResultEntries: [],
    createdAt: 1,
    cwd: "C:/project",
    harness: "codex",
    id: fixtureIdentitySchemas.WorkbenchThreadIdSchema.parse("thread"),
    isDraft: false,
    model: null,
    name: "Thread",
    path: null,
    preview: "Thread",
    reasoningEffort: null,
    serviceTier: null,
    source: "app-server",
    status: "completed",
    tokenUsage: null,
    turnHistory: turns.map(({ id, items }) => ({
      completedAt: 2,
      durationMs: 1_000,
      itemCount: items.length,
      itemIds: items.map((item) => item.id),
      itemTimeline: [],
      loadState: "loaded",
      startedAt: 1,
      status: "completed",
      turnId: id,
    })),
    turns,
    updatedAt: 2,
  };
}

test("questionnaire overlay identity follows item ids rather than reusable request keys", () => {
  const entries = [
    entry("older", "question-older"),
    entry("newer", "question-newer"),
  ];
  const overlaid = applyQuestionnaireHistoryToThread(thread(), entries);
  const questionnaireIds = overlaid.turns.map((currentTurn) => currentTurn.items[1]?.id);

  assert.deepEqual(questionnaireIds, entries.map(({ itemId }) => itemId));
  const repeated = applyQuestionnaireHistoryToThread(overlaid, entries);
  assert.deepEqual(repeated.turns.map(({ items }) => items.filter(isSyntheticQuestionnaireHistoryItem).map(({ id }) => id)),
    entries.map(({ itemId }) => [itemId]));
});

test("questionnaire presentation preserves unfinished and failed tool calls", () => {
  for (const status of ["inProgress", "failed"] as const) {
    const current = thread();
    const item: ThreadItem = {
      type: "dynamicToolCall", id: "tool-call", namespace: null, tool: "workbench_request_user_input",
      arguments: {}, contentItems: null, status, success: status === "failed" ? false : null, durationMs: null,
    };
    current.turns[0]!.items.push(item);
    assert.equal(isSyntheticQuestionnaireHistoryItem(item), false);
    assert.ok(applyQuestionnaireHistoryToThread(current, []).turns[0]!.items.includes(item));
  }
});

test("questionnaire fallback identity includes the owning turn", () => {
  const older = entry("older", null);
  const newer = entry("newer", null);

  assert.notEqual(resolveQuestionnaireHistoryItemId(older), resolveQuestionnaireHistoryItemId(newer));
  assert.match(resolveQuestionnaireHistoryItemId(older), /:older:reused-request-key$/u);
});

test("questionnaire overlay carries each answer resolution time through repeated projection", () => {
  const entries = [entry("older", "question-older"), entry("newer", "question-newer")];
  const projected = applyQuestionnaireHistoryToThread(applyQuestionnaireHistoryToThread(thread(), entries), entries);
  for (const saved of entries) {
    const timeline = projected.turnHistory.find((turn) => turn.turnId === saved.turnId)?.itemTimeline;
    assert.equal(findWorkbenchThreadItemTimelineEntry(resolveQuestionnaireHistoryItemId(saved), timeline)?.completedAt, saved.resolvedAt);
  }
});

test("questionnaire history merging preserves reused keys and replaces only the same item", () => {
  const older = entry("older", "question-older");
  const newer = entry("newer", "question-newer");
  const refreshedOlder = {
    ...older,
    resolvedAt: 5_000,
    response: { answers: { choice: { answers: ["updated"] } } },
  };

  const merged = mergeQuestionnaireHistoryEntries([older], [newer, refreshedOlder]);

  assert.deepEqual(merged.map(resolveQuestionnaireHistoryItemId), ["question-older", "question-newer"]);
  assert.deepEqual(merged[0]?.response, refreshedOlder.response);
});
