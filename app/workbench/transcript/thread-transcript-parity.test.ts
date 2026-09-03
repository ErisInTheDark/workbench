/*
 * No production exports. Tests prove semantic equality uses explicit renderer facts while diagnostics stay bounded and content-free. Keywords: transcript, parity, diagnostics, browser.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { ThreadPayload } from "workbench-shared/types";
import { createSyntheticQuestionnaireHistoryItemId } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import {
  compareWorkbenchTranscriptParity,
  createWorkbenchTranscriptProjectionFailureDiagnostic,
  planWorkbenchTranscriptItemComparison,
} from "./thread-transcript-parity";
import type {
  WorkbenchProjectedTranscriptItem,
  WorkbenchProjectedTranscriptTurn,
  WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";

function turn(items: ThreadItem[]): Turn {
  return {
    completedAt: 3,
    durationMs: 2_000,
    error: null,
    id: "turn",
    items,
    itemsView: "full",
    startedAt: 1,
    status: "completed",
  };
}

function thread(items: ThreadItem[]): ThreadPayload {
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
    turnHistory: [{
      completedAt: 3,
      durationMs: 2_000,
      itemCount: items.length,
      itemIds: items.map(({ id }) => id),
      itemTimeline: items.map(({ id }) => ({
        completedAt: 3_000,
        firstSeenAt: 1_000,
        itemId: id,
        lastSeenAt: 3_000,
        startedAt: 1_000,
      })),
      loadState: "loaded",
      startedAt: 1,
      status: "completed",
      turnId: "turn",
    }],
    turns: [turn(items)],
    updatedAt: 3,
  };
}

function projection(items: WorkbenchProjectedTranscriptItem[]): WorkbenchTranscriptProjection {
  const projectedTurn: WorkbenchProjectedTranscriptTurn = {
    ...turn(items.filter((item): item is ThreadItem => item.type !== "questionnaire" && item.type !== "approval" && item.type !== "unknown")),
    itemTimeline: items.map(({ id }) => ({
      completedAt: 3_000,
      firstSeenAt: 1_000,
      itemId: id,
      lastSeenAt: 3_000,
      startedAt: 1_000,
    })),
    items,
    turnIndex: 0,
  };
  return {
    browseResultEntries: [],
    display: planCanonicalTranscriptDisplay({
      items: items.map((payload, itemIndex) => ({ itemId: payload.id, itemIndex, payload, turnId: "turn" })),
      turns: [{ turnId: "turn", turnIndex: 0 }],
    }),
    hasPreviousTurns: false,
    thread: {
      activityAt: 3_000,
      createdAt: 1_000,
      id: "thread",
      projectId: "project",
      projectRoot: "C:/project",
      title: "Thread",
      updatedAt: 3_000,
    },
    turnHistory: [{
      completedAt: 3,
      durationMs: 2_000,
      itemCount: items.length,
      itemIds: items.map(({ id }) => id),
      itemTimeline: projectedTurn.itemTimeline,
      loadState: "loaded",
      startedAt: 1,
      status: "completed",
      turnId: "turn",
    }],
    turns: [projectedTurn],
  };
}

test("parity compares renderer semantics rather than unsupported provider detail", () => {
  const jsonItem: ThreadItem = {
    clientId: "client",
    content: [{ text: "hello", text_elements: [{ byteRange: { end: 5, start: 0 }, placeholder: "x" }], type: "text" }],
    id: "user",
    type: "userMessage",
  };
  const sqliteItem: ThreadItem = {
    clientId: "client",
    content: [{ text: "hello", text_elements: [], type: "text" }],
    id: "user",
    type: "userMessage",
  };

  assert.deepEqual(compareWorkbenchTranscriptParity({
    jsonBrowseResultEntries: [],
    jsonThread: thread([jsonItem]),
    sqliteProjection: projection([sqliteItem]),
  }), { equal: true });
});

test("settled questionnaire projection equals the current synthetic renderer item", () => {
  const request = {
    id: "request",
    questions: [{ allowOther: false, header: "Pick", id: "choice", isSecret: false, options: [], question: "Which?" }],
    submitLabel: "Submit",
    summary: "Choose",
    title: "Question",
  };
  const response = { answers: { choice: { answers: ["one"] } } };
  const requestKey = "request-key";
  const jsonItem: ThreadItem = {
    arguments: request,
    contentItems: [{ text: JSON.stringify(response, null, 2), type: "inputText" }],
    durationMs: null,
    id: createSyntheticQuestionnaireHistoryItemId({
      itemId: "durable-questionnaire",
      requestKey,
      threadId: "thread",
      turnId: "turn",
    }),
    namespace: null,
    status: "completed",
    success: true,
    tool: "workbench_request_user_input",
    type: "dynamicToolCall",
  };
  const sqliteItem: WorkbenchProjectedTranscriptItem = {
    errorText: null,
    id: "durable-questionnaire",
    request,
    requestKey,
    resolvedAt: 3_000,
    response,
    state: "answered",
    type: "questionnaire",
  };

  assert.deepEqual(compareWorkbenchTranscriptParity({
    jsonBrowseResultEntries: [],
    jsonThread: thread([jsonItem]),
    sqliteProjection: projection([sqliteItem]),
  }), { equal: true });
});

test("parity keeps distinct questionnaire items when provider request keys repeat", () => {
  const request = {
    id: "request",
    questions: [{ allowOther: false, header: "Pick", id: "choice", isSecret: false, options: [], question: "Which?" }],
    submitLabel: "Submit",
    summary: "Choose",
    title: "Question",
  };
  const response = { answers: { choice: { answers: ["one"] } } };
  const requestKey = "reused";
  const jsonItems: ThreadItem[] = ["question-one", "question-two"].map((itemId) => ({
    arguments: request,
    contentItems: [{ text: JSON.stringify(response, null, 2), type: "inputText" }],
    durationMs: null,
    id: createSyntheticQuestionnaireHistoryItemId({
      itemId,
      requestKey,
      threadId: "thread",
      turnId: "turn",
    }),
    namespace: null,
    status: "completed",
    success: true,
    tool: "workbench_request_user_input",
    type: "dynamicToolCall",
  }));
  const sqliteItems: WorkbenchProjectedTranscriptItem[] = ["question-one", "question-two"].map((id) => ({
    errorText: null,
    id,
    request,
    requestKey,
    resolvedAt: 3_000,
    response,
    state: "answered",
    type: "questionnaire",
  }));

  assert.deepEqual(compareWorkbenchTranscriptParity({
    jsonBrowseResultEntries: [],
    jsonThread: thread(jsonItems),
    sqliteProjection: projection(sqliteItems),
  }), { equal: true });
});

test("visual comparison aligns matching items and leaves source-only gaps", () => {
  const jsonItems: ThreadItem[] = [
    { id: "one", text: "one", type: "plan" },
    { id: "json-only", text: "json", type: "plan" },
    { id: "three", text: "three", type: "plan" },
  ];
  const sqliteItems: WorkbenchProjectedTranscriptItem[] = [
    { id: "one", text: "one", type: "plan" },
    { id: "sqlite-only", text: "sqlite", type: "plan" },
    { id: "three", text: "three", type: "plan" },
  ];

  assert.deepEqual(
    planWorkbenchTranscriptItemComparison({
      jsonThread: thread(jsonItems),
      sqliteProjection: projection(sqliteItems),
    }).map((row) => [row.json?.identity ?? null, row.sqlite?.identity ?? null]),
    [
      ["one", "one"],
      ["json-only", null],
      [null, "sqlite-only"],
      ["three", "three"],
    ],
  );
});

test("visual comparison renders reordered identities as remove and add rows", () => {
  const items: ThreadItem[] = [
    { id: "one", text: "one", type: "plan" },
    { id: "two", text: "two", type: "plan" },
    { id: "three", text: "three", type: "plan" },
  ];

  assert.deepEqual(
    planWorkbenchTranscriptItemComparison({
      jsonThread: thread(items),
      sqliteProjection: projection([items[1]!, items[0]!, items[2]!]),
    }).map((row) => [row.json?.identity ?? null, row.sqlite?.identity ?? null]),
    [
      [null, "two"],
      ["one", "one"],
      ["two", null],
      ["three", "three"],
    ],
  );
});

test("visual comparison uses the durable identity for synthetic questionnaire items", () => {
  const request = {
    id: "request",
    questions: [{ allowOther: false, header: "Pick", id: "choice", isSecret: false, options: [], question: "Which?" }],
    submitLabel: "Submit",
    summary: "Choose",
    title: "Question",
  };
  const response = { answers: { choice: { answers: ["one"] } } };
  const requestKey = "request-key";
  const jsonItem: ThreadItem = {
    arguments: request,
    contentItems: [{ text: JSON.stringify(response, null, 2), type: "inputText" }],
    durationMs: null,
    id: createSyntheticQuestionnaireHistoryItemId({
      itemId: "durable-questionnaire",
      requestKey,
      threadId: "thread",
      turnId: "turn",
    }),
    namespace: null,
    status: "completed",
    success: true,
    tool: "workbench_request_user_input",
    type: "dynamicToolCall",
  };
  const sqliteItem: WorkbenchProjectedTranscriptItem = {
    errorText: null,
    id: "durable-questionnaire",
    request,
    requestKey,
    resolvedAt: 3_000,
    response,
    state: "answered",
    type: "questionnaire",
  };

  const rows = planWorkbenchTranscriptItemComparison({
    jsonThread: thread([jsonItem]),
    sqliteProjection: projection([sqliteItem]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.json?.identity, "durable-questionnaire");
  assert.equal(rows[0]?.sqlite?.identity, "durable-questionnaire");
  assert.equal(rows[0]?.json?.sourceItemId, jsonItem.id);
  assert.equal(rows[0]?.sqlite?.sourceItemId, sqliteItem.id);
});

test("first semantic mismatch reports only bounded identities and payload fingerprints", () => {
  const secret = "do-not-leak-this-transcript-text";
  const jsonItem: ThreadItem = { id: "plan", text: secret, type: "plan" };
  const sqliteItem: ThreadItem = { id: "plan", text: "different", type: "plan" };
  const result = compareWorkbenchTranscriptParity({
    jsonBrowseResultEntries: [],
    jsonThread: thread([jsonItem]),
    sqliteProjection: projection([sqliteItem]),
  });

  assert.equal(result.equal, false);
  if (result.equal) return;
  assert.equal(result.diagnostic.scope, "item");
  assert.equal(result.diagnostic.mismatch, "payload");
  assert.equal(result.diagnostic.jsonContext[0]?.id, "plan");
  assert.doesNotMatch(JSON.stringify(result.diagnostic), new RegExp(secret));
});

test("projection failure diagnostics expose table and code but never row values", () => {
  const diagnostic = createWorkbenchTranscriptProjectionFailureDiagnostic("thread", [{
    code: "missingRow",
    itemId: "item",
    table: "threadItemPlans",
  }]);
  assert.deepEqual({
    id: diagnostic.sqliteContext[0]?.id,
    mismatch: diagnostic.mismatch,
    scope: diagnostic.scope,
    type: diagnostic.sqliteContext[0]?.type,
  }, {
    id: "item",
    mismatch: "projectionFailure",
    scope: "projection",
    type: "missingRow",
  });
});
