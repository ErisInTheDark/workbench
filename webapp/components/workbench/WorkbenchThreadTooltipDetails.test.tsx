/*
 * No production exports. Tests protect mounted preview and unmounted live ownership in sidebar tooltip details. Keywords: sidebar, tooltip, questionnaire, proposal, ownership.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchPendingUserInputRequest } from "../../lib/types";
import WorkbenchThreadTooltipDetails from "./WorkbenchThreadTooltipDetails";

const pendingRequest = {
  harness: "codex",
  itemId: "item",
  request: {
    id: "questionnaire",
    questions: [{
      allowOther: false,
      header: "Choice",
      id: "choice",
      isSecret: false,
      options: [{ description: "Keep one owner.", label: "Shared" }],
      question: "Choose a component.",
    }],
    submitLabel: "Send answer",
    summary: "",
    title: "Ownership",
  },
  requestKey: "questionnaire:one",
  threadId: "thread",
  turnId: "turn",
} satisfies WorkbenchPendingUserInputRequest;

function renderDetails(materialized: boolean, cwd: string | null = "C:/workspace", canRead = true) {
  return renderToStaticMarkup(createElement(WorkbenchThreadTooltipDetails, {
    cwd,
    harness: "codex",
    materialized,
    onDraftChange: () => undefined,
    onDraftClear: () => undefined,
    onReadThread: canRead ? async () => null : null,
    onSubmitUserInputRequest: async () => undefined,
    pendingRequest,
    projectId: "project",
    proposalId: "proposal",
    questionnaireDraft: null,
    spellCheck: true,
    threadId: "thread",
  }));
}

test("materialized thread roots render questionnaire and proposal previews", () => {
  const html = renderDetails(true);
  assert.match(html, /data-thread-tooltip-questionnaire="preview"/u);
  assert.match(html, /data-thread-tooltip-proposal="preview"/u);
  assert.doesNotMatch(html, /data-thread-questionnaire-submit|data-thread-checkpoint-commit-action/u);
});

test("unmounted thread roots render the real compact questionnaire and proposal actions", () => {
  const html = renderDetails(false);
  assert.match(html, /data-thread-tooltip-questionnaire="live"/u);
  assert.match(html, /data-thread-tooltip-proposal="commit"/u);
  assert.match(html, /data-thread-questionnaire-submit="true"/u);
  assert.match(html, /data-thread-checkpoint-commit-action="true"/u);
});

test("proposals without cwd remain preview-only", () => {
  const html = renderDetails(false, null);
  assert.match(html, /data-thread-tooltip-proposal="preview"/u);
  assert.doesNotMatch(html, /data-thread-checkpoint-commit-action/u);
});

test("questionnaires remain preview-only while thread controls are unavailable", () => {
  const html = renderDetails(false, "C:/workspace", false);
  assert.match(html, /data-thread-tooltip-questionnaire="preview"/u);
  assert.doesNotMatch(html, /data-thread-questionnaire-submit/u);
});
