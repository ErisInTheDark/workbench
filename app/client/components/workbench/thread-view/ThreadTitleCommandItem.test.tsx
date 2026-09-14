/*
 * Exports:
 * - No production exports; tests protect standalone title-set ownership, ordinary title reads, and title error flow.
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
        pluginId: null,
        processId: null,
        scriptPath: null,
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
    'wb task set --title "Trace cache invalidation"',
    "Task title set: Trace cache invalidation\n",
  );

  assert.match(html, /data-role="thread-title-command"/u);
  assert.match(html, /Trace cache invalidation/u);
});

test("task title reads remain ordinary collapsible command summaries", () => {
  const html = renderCommand("wb task get", "Task title: Trace cache invalidation\n");

  assert.match(html, /Trace cache invalidation/u);
  assert.doesNotMatch(html, /data-role="thread-title-command"/u);
});

test("failed title sets remain owned by the dedicated renderer and surface the error", () => {
  const html = renderToStaticMarkup(createElement(ThreadTitleCommandItem, {
    failureText: "Provider rejected the title.",
    outcome: "failed",
    title: "Trace cache invalidation",
  }));

  assert.match(html, /data-role="thread-title-command"/u);
  assert.match(html, /Provider rejected the title\./u);
});
