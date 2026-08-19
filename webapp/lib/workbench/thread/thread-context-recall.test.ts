/*
 * Exports:
 * - No production exports; Node tests cover filtered history/search paging, tagged output, plan dedupe, and record expansion. Keywords: thread recall, pagination, tags, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem.ts";
import type { UserInput } from "../../codex/generated/app-server/v2/UserInput.ts";
import {
  WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS,
  type WorkbenchThreadContextBundle,
  type WorkbenchThreadRecallKind,
} from "../../types.ts";
import {
  renderWorkbenchThreadRecallExpansionMarkdown,
  renderWorkbenchThreadRecallHistoryMarkdown,
  renderWorkbenchThreadRecallSearchMarkdown,
} from "./thread-context-recall-markdown.ts";
import {
  buildWorkbenchThreadRecallRecords,
  expandWorkbenchThreadRecall,
  readWorkbenchThreadRecallCursor,
  searchWorkbenchThreadRecall,
  selectWorkbenchThreadRecallRecords,
  type WorkbenchThreadRecallRecord,
} from "./thread-context-recall.ts";
import { WORKBENCH_COLLABORATION_CONTROL_MARKER } from "./thread-pause-control.ts";
import { createWorkbenchThreadRecoveryId, createWorkbenchThreadRecoveryInput } from "./thread-recovery-message.ts";
import { createWorkbenchSubagentMessageText } from "./thread-subagent-message.ts";

const ALL_KINDS: WorkbenchThreadRecallKind[] = [
  "agent-message",
  "commentary",
  "final-answer",
  "plan",
  "questionnaire",
  "user-message",
  "user-steer",
];

function turn(id: string, items: ThreadItem[]) {
  return {
    completedAt: 2,
    durationMs: 1_000,
    error: null,
    id,
    items,
    itemsView: "full" as const,
    startedAt: 1,
    status: "completed" as const,
  };
}

function createBundle(): WorkbenchThreadContextBundle {
  const oldPlan = `<plan>\nOLD_HEAD_${"A".repeat(2_200)}OLD_TAIL\n</plan>`;
  const newestPlan = `<plan>\nLATEST_HEAD_${"N".repeat(30_500)}LATEST_TAIL\n</plan>`;
  return {
    browseResultEntries: [],
    questionnaireEntries: [{
      insertAfterItemId: "user-old",
      insertAfterItemIndex: 0,
      itemId: "questionnaire-item",
      request: {
        id: "questionnaire-request",
        questions: [{
          allowOther: true,
          header: "Recall",
          id: "recall-choice",
          isSecret: false,
          options: [{ description: "Keep the safer recall route.", label: "Safe recall" }],
          question: "Which recall route should survive?",
        }],
        submitLabel: "Choose",
        summary: "Choose recall",
        title: "Recall choice",
      },
      requestKey: "questionnaire-key",
      resolvedAt: 5,
      response: { answers: { "recall-choice": { answers: ["Safe recall"] } } },
      threadId: "thread-1",
      turnId: "turn-old",
    }, {
      insertAfterItemId: "user-new",
      insertAfterItemIndex: 3,
      itemId: "questionnaire-item-new",
      request: {
        id: "questionnaire-request-new",
        questions: [{
          allowOther: false,
          header: "Identity",
          id: "identity-choice",
          isSecret: false,
          options: [{ description: "Keep both turn-owned entries.", label: "Keep both" }],
          question: "Can a later turn reuse the same request key?",
        }],
        submitLabel: "Choose",
        summary: "Choose identity",
        title: "Recall identity",
      },
      requestKey: "questionnaire-key",
      resolvedAt: 10,
      response: { answers: { "identity-choice": { answers: ["Keep both"] } } },
      threadId: "thread-1",
      turnId: "turn-new",
    }],
    steerEntries: [{
      attemptedAt: 6,
      canonicalItemId: null,
      entryKey: "turn-steer:139",
      error: null,
      input: [{ text: "steered recall constraint", text_elements: [], type: "text" }],
      requestId: "steer-request",
      resolvedAt: 7,
      status: "sent",
      threadId: "thread-1",
      turnId: "turn-old",
    }, {
      attemptedAt: 8,
      canonicalItemId: null,
      entryKey: "turn-steer:139",
      error: null,
      input: [{
        text: createWorkbenchSubagentMessageText({ message: "active parent progress", name: "Mimi", threadId: "child-active" }),
        text_elements: [],
        type: "text",
      }],
      requestId: "subagent-steer-request",
      resolvedAt: 9,
      status: "sent",
      threadId: "thread-1",
      turnId: "turn-new",
    }, {
      attemptedAt: 11,
      canonicalItemId: null,
      entryKey: "turn-steer:pause-control",
      error: null,
      input: [{
        text: `${WORKBENCH_COLLABORATION_CONTROL_MARKER}\nDeliberately different control prose.`,
        text_elements: [],
        type: "text",
      }],
      requestId: "pause-control-request",
      resolvedAt: 12,
      status: "sent",
      threadId: "thread-1",
      turnId: "turn-new",
    }],
    thread: {
      agentNickname: null,
      agentPath: null,
      agentRole: null,
      createdAt: 1,
      cwd: "C:/workspace",
      forkedFromId: null,
      harness: "codex",
      id: "thread-1",
      isDraft: false,
      model: "test-model",
      name: "Recall test",
      path: null,
      preview: "Recall",
      reasoningEffort: null,
      serviceTier: null,
      source: "appServer",
      status: "idle",
      tokenUsage: null,
      turnHistory: [],
      turns: [
        turn("turn-old", [
          { clientId: null, content: [{ text: "old user", text_elements: [], type: "text" }], id: "user-old", type: "userMessage" },
          { id: "plan-old", memoryCitation: null, phase: "final_answer", text: oldPlan, type: "agentMessage" },
          { content: ["reasoning leak canary"], id: "reasoning-old", summary: [], type: "reasoning" },
          {
            aggregatedOutput: "command leak canary",
            command: "secret-command",
            commandActions: [],
            cwd: "C:/workspace",
            durationMs: 1,
            exitCode: 0,
            id: "command-old",
            processId: null,
            source: "agent",
            status: "completed",
            type: "commandExecution",
          },
        ]),
        turn("turn-new", [
          { id: "commentary-new", memoryCitation: null, phase: "commentary", text: "Normal commentary remembers the safe route.", type: "agentMessage" },
          { id: "plan-new", memoryCitation: null, phase: "final_answer", text: newestPlan, type: "agentMessage" },
          { clientId: createWorkbenchThreadRecoveryId("recall-hidden"), content: createWorkbenchThreadRecoveryInput(), id: "user-recovery", type: "userMessage" },
          { clientId: null, content: [{ text: "newest user constraint", text_elements: [], type: "text" }], id: "user-new", type: "userMessage" },
          {
            clientId: null,
            content: [{
              text: createWorkbenchSubagentMessageText({ message: "idle parent progress", name: "Nell", threadId: "child-idle" }),
              text_elements: [],
              type: "text",
            }],
            id: "user-subagent",
            type: "userMessage",
          },
        ]),
      ],
      updatedAt: 2,
    },
  };
}

test("builds one rich narrative projection and suppresses embedded plans with their selected parent", () => {
  const records = buildWorkbenchThreadRecallRecords(createBundle());
  assert.equal(records.some((record) => record.ref === "user:user-recovery"), false);
  assert(records.some((record) => record.ref === "agent:commentary-new" && record.kind === "commentary"));
  assert(records.some((record) => record.ref === "plan-block:plan-new:0" && record.parentRef === "agent:plan-new"));
  assert.deepEqual(
    records.filter((record) => record.kind === "questionnaire").map((record) => record.ref),
    [
      "questionnaire:turn-old:questionnaire-key",
      "questionnaire:turn-new:questionnaire-key",
    ],
  );
  assert.deepEqual(
    records.filter((record) => record.kind === "user-steer").map((record) => record.ref),
    [
      "steer:turn-old:turn-steer:139",
    ],
  );
  assert(records.some((record) => record.ref === "steer:turn-new:turn-steer:139" && record.kind === "agent-message"));
  assert.deepEqual(
    selectWorkbenchThreadRecallRecords(records, ALL_KINDS)
      .filter((record) => record.ref === "agent:plan-new" || record.ref === "plan-block:plan-new:0")
      .map((record) => record.ref),
    ["agent:plan-new"],
  );
  assert.deepEqual(
    selectWorkbenchThreadRecallRecords(records, ["plan"])
      .filter((record) => record.ref.includes("plan-new"))
      .map((record) => record.ref),
    ["plan-block:plan-new:0"],
  );
});

test("keeps identical native steers correlated to their independent canonical timeline positions", () => {
  const bundle = createBundle();
  const duplicateInput: UserInput[] = [{ text: "identical steer", text_elements: [], type: "text" }];
  bundle.thread.turns = [turn("turn-native", [
    { clientId: "client-first", content: [...duplicateInput], id: "canonical-first", type: "userMessage" },
    { id: "agent-between", memoryCitation: null, phase: "commentary", text: "Between deliveries", type: "agentMessage" },
    { clientId: "client-second", content: [...duplicateInput], id: "canonical-second", type: "userMessage" },
  ])];
  bundle.questionnaireEntries = [];
  bundle.steerEntries = [{
    attemptedAt: 1,
    canonicalItemId: "canonical-first",
    clientUserMessageId: "client-first",
    dispatchSequence: 1,
    entryKey: "turn-steer-client:client-first",
    error: null,
    input: [...duplicateInput],
    requestId: "request-first",
    resolvedAt: 2,
    status: "sent",
    threadId: "thread-1",
    turnId: "turn-native",
  }, {
    attemptedAt: 3,
    canonicalItemId: "canonical-second",
    clientUserMessageId: "client-second",
    dispatchSequence: 2,
    entryKey: "turn-steer-client:client-second",
    error: null,
    input: [...duplicateInput],
    requestId: "request-second",
    resolvedAt: 4,
    status: "sent",
    threadId: "thread-1",
    turnId: "turn-native",
  }];

  const narrative = buildWorkbenchThreadRecallRecords(bundle).filter((record) => (
    record.kind === "user-steer" || record.ref === "agent:agent-between"
  ));
  assert.deepEqual(narrative.map((record) => record.ref), [
    "steer:turn-native:turn-steer-client:client-first",
    "agent:agent-between",
    "steer:turn-native:turn-steer-client:client-second",
  ]);
  assert.deepEqual(narrative.filter((record) => record.kind === "user-steer").map((record) => record.text), [
    "identical steer",
    "identical steer",
  ]);
});

test("renders filtered tagged history backward through a long record with exact cursors", () => {
  const records = selectWorkbenchThreadRecallRecords(buildWorkbenchThreadRecallRecords(createBundle()), ["final-answer"]);
  const newest = renderWorkbenchThreadRecallHistoryMarkdown(records, {
    kinds: ["final-answer"],
    threadId: "thread-1",
  });
  assert(newest.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
  assert.match(newest, /<final-answer id="ref:agent:plan-new"/u);
  assert.match(newest, /LATEST_TAIL/u);
  assert.doesNotMatch(newest, /## Agent final answer/u);
  assert.match(newest, /--kind final-answer --before recall-v1:/u);

  const before = /--before (recall-v1:[^`\s]+)/u.exec(newest)?.[1];
  assert(before);
  const historical = renderWorkbenchThreadRecallHistoryMarkdown(records, {
    before,
    kinds: ["final-answer"],
    threadId: "thread-1",
  });
  assert(historical.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
  assert.match(historical, /LATEST_HEAD/u);
  assert.doesNotMatch(historical, /LATEST_TAIL/u);
  assert.match(historical, /Return to newest: `wb thread recall --thread thread-1 --kind final-answer`/u);
});

test("pages search matches newest-first and excludes non-narrative records", () => {
  const records = buildWorkbenchThreadRecallRecords(createBundle());
  const newest = searchWorkbenchThreadRecall(records, {
    before: null,
    kinds: ALL_KINDS,
    limit: 1,
    query: "safe",
  });
  assert.equal(newest.totalMatches, 2);
  assert.equal(newest.matches[0]?.record.ref, "agent:commentary-new");
  const markdown = renderWorkbenchThreadRecallSearchMarkdown(newest, "thread-1");
  assert.match(markdown, /<commentary id="ref:agent:commentary-new"/u);
  assert.match(markdown, /Previous search page:/u);
  assert.match(markdown, /--kind commentary/u);

  const older = searchWorkbenchThreadRecall(records, {
    before: newest.matches[0]!.record.ref,
    kinds: ALL_KINDS,
    limit: 1,
    query: "safe",
  });
  assert.equal(older.matches[0]?.record.ref, "questionnaire:turn-old:questionnaire-key");
  for (const leakCanary of ["reasoning leak canary", "command leak canary"]) {
    assert.equal(searchWorkbenchThreadRecall(records, {
      before: null,
      kinds: ALL_KINDS,
      limit: 10,
      query: leakCanary,
    }).totalMatches, 0);
  }
});

test("expands one long record through newline-preferred fixed-budget pages", () => {
  const record: WorkbenchThreadRecallRecord = {
    kind: "commentary",
    label: "Agent commentary",
    parentRef: null,
    ref: "agent:long",
    sequence: 0,
    sortKey: "0",
    text: Array.from({ length: 1_500 }, (_, index) => `line-${index}-${"X".repeat(20)}`).join("\n"),
    turnId: "turn-long",
  };
  const first = renderWorkbenchThreadRecallExpansionMarkdown(
    expandWorkbenchThreadRecall([record], { cursor: null, ref: record.ref }),
    "thread-1",
  );
  assert(first.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
  const cursorValue = /--cursor (recall-v1:[^`\s]+)/u.exec(first)?.[1];
  assert(cursorValue);
  const cursor = readWorkbenchThreadRecallCursor(cursorValue);
  assert(cursor && cursor.offset > 0);
  assert.equal(record.text[cursor.offset - 1], "\n");

  const second = renderWorkbenchThreadRecallExpansionMarkdown(
    expandWorkbenchThreadRecall([record], { cursor: cursorValue, ref: record.ref }),
    "thread-1",
  );
  assert(second.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
  assert.match(second, new RegExp(record.text.slice(cursor.offset, cursor.offset + 20), "u"));
  assert.throws(() => expandWorkbenchThreadRecall([record], {
    cursor: cursorValue,
    ref: "agent:missing",
  }), /Unknown Thread Recall ref/u);
});
