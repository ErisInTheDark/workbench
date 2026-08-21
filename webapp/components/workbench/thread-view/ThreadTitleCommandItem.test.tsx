/*
 * Exports:
 * - No production exports; tests protect standalone title-set markers and grouped title reads. Keywords: thread, title, task, command, rendering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadTurnDetails } from "./thread-view-items";
import ThreadTitleCommandItem from "./ThreadTitleCommandItem";

function renderCommand(command: string, aggregatedOutput: string) {
  return renderToStaticMarkup(createElement(ThreadTurnDetails, {
    defaultOpenCompletedWork: true,
    projectRootPath: "C:/workspace",
    threadId: "thread-one",
    turn: {
      completedAt: null,
      durationMs: 5,
      error: null,
      id: "turn-one",
      items: [{
        aggregatedOutput,
        command,
        commandActions: [],
        cwd: "C:/workspace",
        durationMs: 5,
        exitCode: 0,
        id: "title-command",
        processId: null,
        source: "agent",
        status: "completed",
        type: "commandExecution",
      }],
      itemsView: "full",
      startedAt: null,
      status: "completed",
    },
  }));
}

test("title sets render the standalone task marker", () => {
  const html = renderCommand(
    'wb thread title --title "Trace cache invalidation"',
    "Thread title set: Trace cache invalidation\n",
  );

  assert.match(html, /data-role="thread-title-command"/u);
  assert.match(html, />Task:<\/span>[^]*Trace cache invalidation/u);
  assert.doesNotMatch(html, /wb thread title|Thread title set:|Working dir:/u);
});

test("title reads remain ordinary collapsible command summaries", () => {
  const html = renderCommand("wb thread title get", "Thread title: Trace cache invalidation\n");

  assert.match(html, /Checked thread title/u);
  assert.match(html, /Thread title: Trace cache invalidation/u);
  assert.doesNotMatch(html, /data-role="thread-title-command"|Task:/u);
});

test("failed title sets surface the failure without a successful task marker", () => {
  const html = renderToStaticMarkup(createElement(ThreadTitleCommandItem, {
    failureText: "Provider rejected the title.",
    outcome: "failed",
    title: "Trace cache invalidation",
  }));

  assert.match(html, /Failed to set task:/u);
  assert.match(html, /Provider rejected the title\./u);
  assert.doesNotMatch(html, />Task:<\/span>/u);
});
