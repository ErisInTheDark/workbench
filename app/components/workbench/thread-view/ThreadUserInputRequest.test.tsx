/*
 * No production exports. Tests protect freeform-only and one-option quick responses plus compact questionnaire preview, live, history, and hydrated draft modes. Keywords: questionnaire, freeform, quick response, quill, compact, preview, live, history, draft.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkbenchQuestionnaireDraft, WorkbenchUserInputRequest } from "workbench-shared/types";
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

const quickResponseRequest = {
  ...request,
  id: "quick-questionnaire",
  questions: [{
    ...request.questions[0],
    options: [request.questions[0].options[0]],
  }],
} satisfies WorkbenchUserInputRequest;

const freeformRequest = {
  ...request,
  id: "freeform-questionnaire",
  questions: [{
    ...request.questions[0],
    options: [],
    question: "What should change?",
  }],
  title: "Choice",
} satisfies WorkbenchUserInputRequest;

test("freeform-only live questionnaire renders one prompted input and submit action in both layouts", () => {
  for (const presentation of ["full", "compact"] as const) {
    const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
      draft: null,
      mode: "live",
      onDraftChange: () => undefined,
      onDraftClear: () => undefined,
      onSubmit: async () => undefined,
      presentation,
      request: freeformRequest,
      spellCheck: true,
    }));
    assert.equal(html.match(/role="textbox"/gu)?.length, 1);
    assert.match(html, /data-placeholder="[^"]+"/u);
    assert.match(html, /data-thread-questionnaire-submit="true"/u);
    assert.doesNotMatch(html, /aria-pressed/u);
    if (presentation === "full") {
      assert.equal(html.match(/>Choice</gu)?.length, 1);
      assert.match(html, />What should change\?</u);
    }
  }
});

test("a distinct request title keeps its sole question eyebrow", () => {
  const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
    draft: null,
    mode: "live",
    onDraftChange: () => undefined,
    onDraftClear: () => undefined,
    onSubmit: async () => undefined,
    presentation: "full",
    request: {
      ...freeformRequest,
      title: "Component ownership",
    },
    spellCheck: true,
  }));
  assert.match(html, />Component ownership</u);
  assert.match(html, />Choice</u);
});

test("freeform-only questionnaire history renders its answer without option controls", () => {
  const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
    mode: "history",
    request: freeformRequest,
    response: {
      answers: {
        choice: { answers: ["Keep one real owner."] },
      },
    },
  }));
  assert.match(html, /Keep one real owner\./u);
  assert.doesNotMatch(html, /aria-pressed/u);
});

test("one-option live questionnaire renders immediate option and custom-response actions", () => {
  const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
    draft: null,
    mode: "live",
    onDraftChange: () => undefined,
    onDraftClear: () => undefined,
    onSubmit: async () => undefined,
    presentation: "compact",
    request: quickResponseRequest,
    spellCheck: true,
  }));
  assert.equal(html.match(/<button/gu)?.length, 2);
  assert.equal(html.match(/<button[^>]*aria-label=/gu)?.length, 1);
  assert.match(html, />Shared</u);
  assert.doesNotMatch(html, /aria-pressed/u);
  assert.doesNotMatch(html, /role="textbox"/u);
  assert.doesNotMatch(html, /data-thread-questionnaire-submit/u);
});

test("one-option questionnaire with hydrated custom text starts in normal mode without taking focus", () => {
  const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
    draft: {
      ...draft,
      selectedValues: {},
    },
    mode: "live",
    onDraftChange: () => undefined,
    onDraftClear: () => undefined,
    onSubmit: async () => undefined,
    request: quickResponseRequest,
    spellCheck: true,
  }));
  assert.match(html, /role="textbox"/u);
  assert.match(html, /Keep one owner\./u);
  assert.doesNotMatch(html, /autofocus/u);
  assert.match(html, /data-thread-questionnaire-submit="true"/u);
});

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
