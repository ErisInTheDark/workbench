/*
 * No production exports. Tests protect item alignment, source gaps, shared live reasoning omission, and relational fallback rendering. Keywords: transcript, parity, comparison, reasoning, React.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { ThreadPayload } from "workbench-shared/types";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import type {
  WorkbenchProjectedTranscriptItem,
  WorkbenchProjectedTranscriptTurn,
  WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import ThreadTranscriptComparison from "./ThreadTranscriptComparison";

function createThread(items: ThreadItem[]): ThreadPayload {
  const turn = {
    completedAt: 3,
    durationMs: 2_000,
    error: null,
    id: "turn",
    items,
    itemsView: "full" as const,
    startedAt: 1,
    status: "completed" as const,
  };
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
      itemTimeline: [],
      loadState: "loaded",
      startedAt: 1,
      status: "completed",
      turnId: "turn",
    }],
    turns: [turn],
    updatedAt: 3,
  };
}

function createProjection(items: WorkbenchProjectedTranscriptItem[]): WorkbenchTranscriptProjection {
  const turn: WorkbenchProjectedTranscriptTurn = {
    completedAt: 3,
    durationMs: 2_000,
    error: null,
    id: "turn",
    items,
    itemsView: "full",
    itemTimeline: [],
    startedAt: 1,
    status: "completed",
    turnIndex: 0,
  };
  return {
    browseResultEntries: [],
    display: planCanonicalTranscriptDisplay({
      items: items.map((payload, itemIndex) => ({
        itemId: payload.id,
        itemIndex,
        payload,
        turnId: "turn",
      })),
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
      itemTimeline: [],
      loadState: "loaded",
      startedAt: 1,
      status: "completed",
      turnId: "turn",
    }],
    turns: [turn],
  };
}

function renderComparison(
  jsonItems: ThreadItem[],
  sqliteItems: WorkbenchProjectedTranscriptItem[],
  hiddenReasoningStep?: {
    itemId: string;
    sectionIndex: number;
    source: "content" | "summary";
  },
) {
  return renderToStaticMarkup(
    <ThreadTranscriptComparison
      hiddenReasoningStep={hiddenReasoningStep}
      jsonBrowseResultEntries={[]}
      jsonThread={createThread(jsonItems)}
      knownSkills={[]}
      projectFilePaths={[]}
      projectId="project"
      projectRootPath="C:/project"
      relatedThreadsById={{}}
      sqliteProjection={createProjection(sqliteItems)}
      subagents={[]}
      visibleTurnIds={new Set(["turn"])}
      workspaceRoots={[]}
    />,
  );
}

test("comparison renders both sources and explicit gaps without losing later aligned items", () => {
  const html = renderComparison(
    [
      { id: "shared", memoryCitation: null, phase: "commentary", text: "shared JSON", type: "agentMessage" },
      { id: "json-only", memoryCitation: null, phase: "commentary", text: "JSON only", type: "agentMessage" },
      { id: "tail", memoryCitation: null, phase: "final_answer", text: "tail JSON", type: "agentMessage" },
    ],
    [
      { id: "shared", memoryCitation: null, phase: "commentary", text: "shared SQLite", type: "agentMessage" },
      { id: "sqlite-only", memoryCitation: null, phase: "commentary", text: "SQLite only", type: "agentMessage" },
      { id: "tail", memoryCitation: null, phase: "final_answer", text: "tail SQLite", type: "agentMessage" },
    ],
  );

  assert.match(html, /JSON transcript/u);
  assert.match(html, /SQLite transcript/u);
  assert.match(html, /JSON only/u);
  assert.match(html, /SQLite only/u);
  assert.match(html, /Missing json-only/u);
  assert.match(html, /Missing sqlite-only/u);
  assert.match(html, /tail JSON/u);
  assert.match(html, /tail SQLite/u);
});

test("comparison renders projected questionnaires and unknown items through bounded item UI", () => {
  const html = renderComparison(
    [],
    [{
      errorText: null,
      id: "question",
      request: {
        id: "request",
        questions: [{
          allowOther: false,
          header: "Pick",
          id: "choice",
          isSecret: false,
          options: [],
          question: "Which option?",
        }],
        submitLabel: "Submit",
        summary: "Choose",
        title: "Question",
      },
      requestKey: "request-key",
      resolvedAt: 3_000,
      response: { answers: { choice: { answers: ["one"] } } },
      state: "answered",
      type: "questionnaire",
    }, {
      id: "unknown",
      nativeType: "futureItem",
      safeValue: { safe: true },
      type: "unknown",
    }],
  );

  assert.match(html, /Which option\?/u);
  assert.match(html, /one/u);
  assert.match(html, /Unknown thread item/u);
});

test("comparison includes SQLite-only turns outside the JSON visible turn set", () => {
  const sqliteOnlyItem: ThreadItem = {
    id: "sqlite-extra",
    memoryCitation: null,
    phase: "commentary",
    text: "SQLite extra turn",
    type: "agentMessage",
  };
  const sqliteProjection = createProjection([]);
  sqliteProjection.turns.push({
    completedAt: 5,
    durationMs: 1_000,
    error: null,
    id: "sqlite-turn",
    items: [sqliteOnlyItem],
    itemsView: "full",
    itemTimeline: [],
    startedAt: 4,
    status: "completed",
    turnIndex: 1,
  });
  sqliteProjection.turnHistory.push({
    completedAt: 5,
    durationMs: 1_000,
    itemCount: 1,
    itemIds: [sqliteOnlyItem.id],
    itemTimeline: [],
    loadState: "loaded",
    startedAt: 4,
    status: "completed",
    turnId: "sqlite-turn",
  });
  sqliteProjection.display = planCanonicalTranscriptDisplay({
    items: [{
      itemId: sqliteOnlyItem.id,
      itemIndex: 0,
      payload: sqliteOnlyItem,
      turnId: "sqlite-turn",
    }],
    turns: [
      { turnId: "turn", turnIndex: 0 },
      { turnId: "sqlite-turn", turnIndex: 1 },
    ],
  });

  const html = renderToStaticMarkup(
    <ThreadTranscriptComparison
      jsonBrowseResultEntries={[]}
      jsonThread={createThread([])}
      knownSkills={[]}
      projectFilePaths={[]}
      projectId="project"
      projectRootPath="C:/project"
      relatedThreadsById={{}}
      sqliteProjection={sqliteProjection}
      subagents={[]}
      visibleTurnIds={new Set(["turn"])}
      workspaceRoots={[]}
    />,
  );

  assert.match(html, /SQLite extra turn/u);
  assert.match(html, /Missing sqlite-extra/u);
});

test("comparison keeps the shared live reasoning step out of both transcript cells", () => {
  const reasoning: Extract<ThreadItem, { type: "reasoning" }> = {
    content: [],
    id: "reasoning",
    summary: ["Earlier title", "Latest title\nLive detail."],
    type: "reasoning",
  };
  const html = renderComparison([reasoning], [reasoning], {
    itemId: "reasoning",
    sectionIndex: 1,
    source: "summary",
  });

  assert.equal((html.match(/Earlier title/gu) ?? []).length, 2);
  assert.doesNotMatch(html, /Latest title|Live detail/u);
});
