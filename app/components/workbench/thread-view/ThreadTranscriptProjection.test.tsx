/*
 * No production exports. Tests protect canonical SQLite segment order, turn ownership, Browse attachment, and JSON-independent rendering. Keywords: transcript, SQLite, projection, canonical, Browse.
 */
import assert from "node:assert/strict";
import { createRef } from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchBrowseResultEntry } from "workbench-shared/types";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import type {
  WorkbenchProjectedTranscriptItem,
  WorkbenchProjectedTranscriptTurn,
  WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import ThreadTranscriptProjection from "./ThreadTranscriptProjection";

function turn(id: string, turnIndex: number, items: ThreadItem[]): WorkbenchProjectedTranscriptTurn {
  return {
    completedAt: 3,
    durationMs: 2_000,
    error: null,
    id,
    items,
    itemsView: "full",
    itemTimeline: [],
    startedAt: 1,
    status: "completed",
    turnIndex,
  };
}

test("SQLite projection renders canonical segments and turn-owned Browse details without JSON", () => {
  const first: ThreadItem = {
    id: "first",
    memoryCitation: null,
    phase: "commentary",
    text: "First SQLite item",
    type: "agentMessage",
  };
  const browse: Extract<ThreadItem, { type: "commandExecution" }> = {
    aggregatedOutput: "",
    command: 'wb browse run --thread thread --session rendering --summary "Check page" --command "snapshot --compact"',
    commandActions: [],
    cwd: "C:/project",
    durationMs: 10,
    exitCode: 0,
    id: "browse",
    pluginId: null,
    processId: null,
    scriptPath: null,
    source: "agent",
    status: "completed",
    type: "commandExecution",
  };
  const last: ThreadItem = {
    id: "last",
    memoryCitation: null,
    phase: "final_answer",
    text: "Last SQLite item",
    type: "agentMessage",
  };
  const turns = [
    turn("turn-one", 0, [first, last]),
    turn("turn-two", 1, [browse]),
  ];
  const browseResultEntries: WorkbenchBrowseResultEntry[] = [{
    action: "snapshot",
    actionIndex: 0,
    assetUrl: null,
    commandItemId: browse.id,
    detailKind: "result",
    detailLabel: "SQLite Browse detail",
    detailText: "Attached to turn two",
    durationMs: 10,
    entryKey: "browse:0",
    recordedAt: 2_000,
    session: "rendering",
    state: "completed",
    threadId: "thread",
    turnId: "turn-two",
  }];
  const projection: WorkbenchTranscriptProjection = {
    browseResultEntries,
    display: planCanonicalTranscriptDisplay<WorkbenchProjectedTranscriptItem>({
      items: [
        { itemId: first.id, itemIndex: 0, payload: first, turnId: "turn-one" },
        { itemId: last.id, itemIndex: 1, payload: last, turnId: "turn-one" },
        { itemId: browse.id, itemIndex: 2, payload: browse, turnId: "turn-two" },
      ],
      turns: turns.map(({ id, turnIndex }) => ({ turnId: id, turnIndex })),
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
    turnHistory: [],
    turns,
  };

  const html = renderToStaticMarkup(
    <ThreadTranscriptProjection
      canLoadPreviousTurn={false}
      historySentinelRef={createRef<HTMLDivElement>()}
      knownSkills={[]}
      projectFilePaths={[]}
      projectId="project"
      projectRootPath="C:/project"
      projection={projection}
      relatedThreadsById={{}}
      subagents={[]}
      workspaceRoots={[]}
    />,
  );

  const firstIndex = html.indexOf("First SQLite item");
  const lastIndex = html.indexOf("Last SQLite item");
  const browseIndex = html.indexOf("SQLite Browse detail");
  assert.notEqual(firstIndex, -1);
  assert.notEqual(browseIndex, -1);
  assert.notEqual(lastIndex, -1);
  assert.equal(firstIndex < lastIndex && lastIndex < browseIndex, true);
  assert.equal((html.match(/data-thread-history-turn-id="turn-one"/gu) ?? []).length, 1);
  assert.equal((html.match(/data-thread-history-turn-id="turn-two"/gu) ?? []).length, 1);
});
