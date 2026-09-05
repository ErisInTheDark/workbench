/*
 * No production exports. Tests protect complete Codex history collapse, stable global indexes, exact timelines, and settled interaction placement. Keywords: codex, transcript, sqlite, import.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { WorkbenchQuestionnaireHistoryEntry, WorkbenchThreadTurnHistoryEntry } from "workbench-shared/types";
import { createCodexTranscriptSqliteImport } from "./codex-transcript-sqlite-import.ts";

function thread(): Thread & { workbenchTurnHistory: WorkbenchThreadTurnHistoryEntry[] } {
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
    model: null,
    projectId: null,
    reasoningEffort: null,
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
      completedAt: 3,
      durationMs: 2_000,
      error: null,
      id: "older",
      items: [{ id: "older-message", memoryCitation: null, delivery: null, questions: null, phase: "commentary", text: "older", type: "agentMessage" }],
      itemsView: "full",
      startedAt: 1,
      status: "completed",
    }, {
      completedAt: 6,
      durationMs: 2_000,
      error: null,
      id: "newer",
      items: [
        {
          clientId: "prompt-client",
          content: [{ text: "go", text_elements: [], type: "text" }],
          id: "prompt",
          type: "userMessage",
        },
        { id: "answer", memoryCitation: null, delivery: null, questions: null, phase: "final_answer", text: "done", type: "agentMessage" },
      ],
      itemsView: "full",
      startedAt: 4,
      status: "completed",
    }],
    updatedAt: 6,
    workbenchTurnHistory: [{
      completedAt: 3,
      durationMs: 2_000,
      itemCount: 1,
      itemTimeline: [{
        aliases: ["older-alias"],
        completedAt: 3_000,
        firstSeenAt: 1_100,
        itemId: "older-message",
        lastSeenAt: 3_000,
        startedAt: 1_200,
      }],
      loadState: "loaded",
      startedAt: 1,
      status: "completed",
      turnId: "older",
    }, {
      completedAt: 6,
      durationMs: 2_000,
      itemCount: 2,
      itemTimeline: [],
      loadState: "loaded",
      startedAt: 4,
      status: "completed",
      turnId: "newer",
    }],
  } satisfies Thread & { workbenchTurnHistory: WorkbenchThreadTurnHistoryEntry[] };
}

test("complete import uses full history order, exact timeline facts, and durable questionnaire placement", () => {
  const questionnaire: WorkbenchQuestionnaireHistoryEntry = {
    insertAfterItemId: "prompt",
    insertAfterItemIndex: 0,
    itemId: null,
    request: {
      id: "request",
      questions: [{ allowOther: false, header: "Pick", id: "choice", isSecret: false, options: [], question: "Which?" }],
      submitLabel: "Submit",
      summary: "Choose",
      title: "Question",
    },
    requestKey: "request-key",
    resolvedAt: 5_000,
    response: { answers: { choice: { answers: ["one"] } } },
    threadId: "thread",
    turnId: "newer",
  };
  const snapshot = createCodexTranscriptSqliteImport({
    browseResultEntries: [],
    context: {
      activityAt: 6_000,
      createdAt: 1_000,
      nativeLocation: "C:/repo",
      projectId: "project",
      projectRoot: "C:/repo",
      title: "Thread",
      updatedAt: 6_000,
    },
    questionnaireEntries: [questionnaire],
    steerEntries: [],
    thread: thread(),
  });
  assert.equal(snapshot.kind, "canonicalWindow");
  if (snapshot.kind !== "canonicalWindow") return;
  const turns = snapshot.observations.filter((entry) => entry.kind === "turn");
  assert.deepEqual(turns.map(({ turnId, turnIndex }) => [turnId, turnIndex]), [["older", 0], ["newer", 1]]);
  const items = snapshot.observations.filter((entry) => entry.kind === "item" || entry.kind === "questionnaire");
  assert.deepEqual(snapshot.materializedTurnIds, ["older", "newer"]);
  assert.deepEqual(items.map((entry) => (
    entry.kind === "questionnaire" ? entry.entry.requestKey : entry.item.id
  )), ["older-message", "prompt", "request-key", "answer"]);
  const older = items[0];
  assert.equal(older?.kind, "item");
  if (older?.kind === "item") {
    assert.deepEqual(older.timeline, {
      aliases: ["older-alias"],
      completedAt: 3_000,
      firstSeenAt: 1_100,
      itemId: "older-message",
      lastSeenAt: 3_000,
      startedAt: 1_200,
    });
  }
});

test("reused provider request keys keep questionnaire observations in their owning turns", () => {
  const questionnaire = (
    turnId: string,
    itemId: string,
    insertAfterItemId: string,
  ): WorkbenchQuestionnaireHistoryEntry => ({
    insertAfterItemId,
    insertAfterItemIndex: 0,
    itemId,
    request: {
      id: `request-${turnId}`,
      questions: [{ allowOther: false, header: "Pick", id: "choice", isSecret: false, options: [], question: "Which?" }],
      submitLabel: "Submit",
      summary: "Choose",
      title: "Question",
    },
    requestKey: "reused",
    resolvedAt: turnId === "older" ? 2_000 : 5_000,
    response: { answers: { choice: { answers: [turnId] } } },
    threadId: "thread",
    turnId,
  });
  const questionnaires = [
    questionnaire("older", "question-older", "older-message"),
    questionnaire("newer", "question-newer", "prompt"),
  ];
  const snapshot = createCodexTranscriptSqliteImport({
    browseResultEntries: [],
    context: {
      activityAt: 6_000,
      createdAt: 1_000,
      nativeLocation: "C:/repo",
      projectId: "project",
      projectRoot: "C:/repo",
      title: "Thread",
      updatedAt: 6_000,
    },
    questionnaireEntries: questionnaires,
    steerEntries: [],
    thread: thread(),
  });
  assert.equal(snapshot.kind, "canonicalWindow");
  if (snapshot.kind !== "canonicalWindow") return;

  assert.deepEqual(
    snapshot.observations
      .filter((observation) => observation.kind === "questionnaire")
      .map(({ entry }) => [entry.turnId, entry.itemId, entry.requestKey]),
    [
      ["older", "question-older", "reused"],
      ["newer", "question-newer", "reused"],
    ],
  );
});

test("latest-only import omits items owned by an unloaded earlier turn", () => {
  const carriedThread = thread();
  const olderItem = carriedThread.turns[0]!.items[0]!;
  carriedThread.turns = [{
    ...carriedThread.turns[1]!,
    items: [olderItem, ...carriedThread.turns[1]!.items],
  }];
  carriedThread.workbenchTurnHistory = [{
    ...carriedThread.workbenchTurnHistory[0]!,
    itemIds: [olderItem.id],
    loadState: "unloaded",
  }, {
    ...carriedThread.workbenchTurnHistory[1]!,
    itemIds: [olderItem.id, "prompt", "answer"],
  }];

  const snapshot = createCodexTranscriptSqliteImport({
    browseResultEntries: [],
    context: {
      activityAt: 6_000,
      createdAt: 1_000,
      nativeLocation: "C:/repo",
      projectId: "project",
      projectRoot: "C:/repo",
      title: "Thread",
      updatedAt: 6_000,
    },
    questionnaireEntries: [],
    steerEntries: [],
    thread: carriedThread,
  });
  assert.equal(snapshot.kind, "canonicalWindow");
  if (snapshot.kind !== "canonicalWindow") return;

  assert.deepEqual(snapshot.materializedTurnIds, ["newer"]);
  assert.deepEqual(
    snapshot.observations
      .filter((observation) => observation.kind === "item")
      .map(({ item, turnId }) => [turnId, item.id]),
    [["newer", "prompt"], ["newer", "answer"]],
  );
});
