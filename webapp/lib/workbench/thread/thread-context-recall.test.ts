/*
 * Exports:
 * - No production exports; Node tests cover Thread Recall paging, plan previews, search allowlisting, and expansion. Keywords: thread recall, pagination, search, test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem.ts";
import {
  WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS,
  type WorkbenchThreadContextBundle,
} from "../../types.ts";
import {
  renderWorkbenchThreadRecallExpansionMarkdown,
  renderWorkbenchThreadRecallSearchMarkdown,
} from "./thread-context-recall-markdown.ts";
import {
  buildWorkbenchThreadRecallRecords,
  expandWorkbenchThreadRecall,
  searchWorkbenchThreadRecall,
} from "./thread-context-recall.ts";
import { renderWorkbenchThreadRecallHistoryMarkdown } from "./thread-context-markdown.ts";
import { buildWorkbenchThreadContextPieces } from "./thread-context-projection.ts";

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
  const oldPlan = `<plan>\nOLD_HEAD_${"A".repeat(2_200)}OLD_MIDDLE_SHOULD_NOT_APPEAR${"B".repeat(1_000)}\n</plan>`;
  const newestPlan = `<plan>\nLATEST_HEAD_${"N".repeat(10_500)}LATEST_TAIL_SHOULD_NOT_APPEAR${"Z".repeat(1_000)}\n</plan>`;
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
    }],
    steerEntries: [{
      attemptedAt: 6,
      canonicalItemId: null,
      entryKey: "steer-key",
      error: null,
      input: [{ text: "steered recall constraint", text_elements: [], type: "text" }],
      requestId: "steer-request",
      resolvedAt: 7,
      status: "sent",
      threadId: "thread-1",
      turnId: "turn-old",
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
          { clientId: null, content: [{ text: `old user ${"U".repeat(9_000)}`, text_elements: [], type: "text" }], id: "user-old", type: "userMessage" },
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
          { id: "commentary-new", memoryCitation: null, phase: "commentary", text: "Normal   commentary remembers the safe route.", type: "agentMessage" },
          { id: "plan-new", memoryCitation: null, phase: "final_answer", text: newestPlan, type: "agentMessage" },
          { clientId: null, content: [{ text: "newest user constraint", text_elements: [], type: "text" }], id: "user-new", type: "userMessage" },
        ]),
      ],
      unreadBadge: null,
      updatedAt: 2,
    },
  };
}

test("renders bounded newest and historical pages with global plan preview limits", () => {
  const bundle = createBundle();
  const pieces = buildWorkbenchThreadContextPieces(bundle);
  const newest = renderWorkbenchThreadRecallHistoryMarkdown(pieces, { threadId: bundle.thread.id });
  assert(newest.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
  assert.match(newest, /newest user constraint/u);
  assert.match(newest, /Showing the first 10,000/u);
  assert.doesNotMatch(newest, /LATEST_TAIL_SHOULD_NOT_APPEAR/u);
  assert.match(newest, /Showing the first 2,000/u);
  assert.doesNotMatch(newest, /OLD_MIDDLE_SHOULD_NOT_APPEAR/u);
  assert.match(newest, /Previous page: `wb thread recall/u);

  const before = /--before ([^`\s]+)/u.exec(newest)?.[1];
  assert(before);
  const historical = renderWorkbenchThreadRecallHistoryMarkdown(pieces, { before, threadId: bundle.thread.id });
  assert(historical.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
  assert.match(historical, /WARNING: Newer thread evidence is intentionally omitted/u);
  assert.match(historical, /Return to newest: `wb thread recall/u);
  assert.doesNotMatch(historical, /newest user constraint/u);
  assert.doesNotMatch(historical, /Showing the first 10,000/u);
});

test("searches only narrative records with stable refs and normalized literal matching", () => {
  const records = buildWorkbenchThreadRecallRecords(createBundle());
  assert(records.some((record) => record.ref === "plan-block:plan-new:0"));
  assert(!records.some((record) => record.ref === "agent:plan-new"));

  const result = searchWorkbenchThreadRecall(records, {
    kinds: ["agent", "user", "questionnaire", "plan", "steer"],
    limit: 10,
    query: "NORMAL commentary",
  });
  assert.equal(result.totalMatches, 1);
  assert.equal(result.matches[0]?.record.ref, "agent:commentary-new");
  const markdown = renderWorkbenchThreadRecallSearchMarkdown(result);
  assert(markdown.length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
  assert.match(markdown, /agent:commentary-new/u);

  for (const leakCanary of ["reasoning leak canary", "command leak canary"]) {
    assert.equal(searchWorkbenchThreadRecall(records, {
      kinds: ["agent", "user", "questionnaire", "plan", "steer"],
      limit: 10,
      query: leakCanary,
    }).totalMatches, 0);
  }
});

test("expands exact refs under the requested transport budget", () => {
  const records = buildWorkbenchThreadRecallRecords(createBundle());
  const expansion = expandWorkbenchThreadRecall(records, {
    after: 1,
    before: 1,
    ref: "plan-block:plan-new:0",
  });
  const markdown = renderWorkbenchThreadRecallExpansionMarkdown(expansion, 4_000);
  assert(markdown.length <= 4_000);
  assert.match(markdown, /plan-block:plan-new:0/u);
  assert.match(markdown, /target characters omitted/u);
  assert.throws(() => expandWorkbenchThreadRecall(records, {
    after: 1,
    before: 1,
    ref: "plan-block:missing:0",
  }), /Unknown Thread Recall ref/u);
});
