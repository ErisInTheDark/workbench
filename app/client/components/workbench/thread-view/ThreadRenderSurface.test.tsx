/*
 * No production exports. Tests protect explicit whole-transcript expiry presentation.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";

import type { WorkbenchTranscriptProjection } from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import ThreadRenderSurface from "./ThreadRenderSurface";

test("an expired transcript renders its retention state instead of the generic empty message", () => {
  const projection: WorkbenchTranscriptProjection = {
    approvalEntries: [],
    browseResultEntries: [],
    display: { orderedItems: [], segments: [] },
    hasPreviousTurns: false,
    questionnaireEntries: [],
    steerEntries: [],
    thread: {
      activityAt: 3,
      createdAt: 1,
      cwd: "C:/project",
      id: "thread",
      projectId: "project",
      projectRoot: "C:/project",
      title: "Thread",
      updatedAt: 3,
    },
    turnHistory: [],
    turns: [{
      completedAt: 2,
      durationMs: 1,
      error: null,
      id: "turn",
      items: [],
      itemsView: "full",
      itemTimeline: [],
      payloadExpiredAt: 4,
      startedAt: 1,
      status: "completed",
      turnIndex: 0,
    }],
  };
  const html = renderToStaticMarkup(createElement(ThreadRenderSurface, {
    emptyMessage: "Nothing captured.",
    sql: {
      canLoadPrevious: false,
      loading: false,
      loadPrevious: () => undefined,
      projection,
    },
    thread: null,
  }));

  assert.match(html, /Transcript expired 3 days after settlement\./u);
  assert.doesNotMatch(html, /Nothing captured\./u);
});
