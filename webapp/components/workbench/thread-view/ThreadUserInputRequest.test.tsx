/*
 * No production exports. Tests protect compact questionnaire preview and live modes while preserving the shared renderer. Keywords: questionnaire, compact, preview, live, draft.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchQuestionnaireDraft, WorkbenchUserInputRequest } from "../../../lib/types";
import ThreadUserInputRequest from "./ThreadUserInputRequest";

const request = {
  id: "questionnaire",
  questions: [{
    allowOther: true,
    header: "Choice",
    id: "choice",
    isSecret: false,
    options: [
      { description: "Use the shared owner.", label: "Shared" },
      { description: "Create a drifting clone.", label: "Clone" },
    ],
    question: "Which component should render this?",
  }],
  submitLabel: "Send answer",
  summary: "",
  title: "Component ownership",
} satisfies WorkbenchUserInputRequest;

const draft = {
  attachments: [],
  customValues: { choice: "Keep one owner." },
  selectedValues: { choice: ["Shared"] },
  updatedAt: 1,
} satisfies WorkbenchQuestionnaireDraft;

const emptyDraft = {
  ...draft,
  customValues: {},
} satisfies WorkbenchQuestionnaireDraft;

test("compact questionnaire preview renders persisted answers without mutation controls", () => {
  const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
    draft,
    mode: "preview",
    presentation: "compact",
    request,
  }));
  assert.match(html, /data-thread-user-input-presentation="compact"/u);
  assert.match(html, /Which component should render this\?/u);
  assert.match(html, /aria-pressed="true"[\s\S]*?Shared/u);
  assert.match(html, /Keep one owner\./u);
  assert.match(html, /data-workbench-option-presentation="compact-inline"/u);
  assert.doesNotMatch(html, /data-thread-questionnaire-submit/u);
});

test("compact live questionnaire keeps one custom input beside the shared submit action", () => {
  const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
    draft: emptyDraft,
    mode: "live",
    onDraftChange: () => undefined,
    onDraftClear: () => undefined,
    onSubmit: async () => undefined,
    presentation: "compact",
    request,
    spellCheck: true,
  }));
  assert.match(html, /data-thread-user-input-presentation="compact"/u);
  assert.match(html, /data-thread-questionnaire-custom-layout="compact-flow"/u);
  assert.equal(html.match(/role="textbox"/gu)?.length, 1);
  assert.match(html, /data-empty="true"/u);
  assert.match(html, /<button[^>]*aria-pressed="true"/u);
  assert.match(html, /data-thread-questionnaire-submit="true"/u);
});

test("full live questionnaire remains the default with its shared submit control", () => {
  const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
    draft,
    mode: "live",
    onDraftChange: () => undefined,
    onDraftClear: () => undefined,
    onSubmit: async () => undefined,
    request,
    spellCheck: false,
  }));
  assert.match(html, /data-thread-user-input-presentation="full"/u);
  assert.match(html, /data-thread-questionnaire-submit="true"/u);
});
