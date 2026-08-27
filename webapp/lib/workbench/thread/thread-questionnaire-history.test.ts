/*
 * No production exports. Tests protect permanent questionnaire item identity when provider request keys repeat across turns.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../../codex/generated/app-server/v2/Turn";
import type { ThreadPayload, WorkbenchQuestionnaireHistoryEntry } from "../../types";
import {
  applyQuestionnaireHistoryToThread,
} from "./thread-questionnaire-history";
import {
  createSyntheticQuestionnaireHistoryItemId,
  mergeQuestionnaireHistoryEntries,
  readSyntheticQuestionnaireHistoryItemId,
  resolveQuestionnaireHistoryItemId,
} from "./thread-questionnaire-identity";

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
    forkedFromId: null,
    harness: "codex",
    id: "thread",
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

  assert.deepEqual(questionnaireIds, entries.map(createSyntheticQuestionnaireHistoryItemId));
  assert.deepEqual(questionnaireIds.map((itemId) => (
    readSyntheticQuestionnaireHistoryItemId(itemId!)
  )), ["question-older", "question-newer"]);
});

test("questionnaire fallback identity includes the owning turn", () => {
  const older = entry("older", null);
  const newer = entry("newer", null);

  assert.notEqual(resolveQuestionnaireHistoryItemId(older), resolveQuestionnaireHistoryItemId(newer));
  assert.match(resolveQuestionnaireHistoryItemId(older), /:older:reused-request-key$/u);
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
