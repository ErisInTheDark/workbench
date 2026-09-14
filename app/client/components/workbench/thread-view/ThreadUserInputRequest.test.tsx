/*
 * No production exports. Tests protect questionnaire loading, framing, answer modes, and hydrated drafts.
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

test("loading questionnaires need no request or draft and expose no answer controls", () => {
  for (const presentation of ["full", "compact"] as const) {
    const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
      mode: "loading",
      presentation,
    }));
    assert.match(html, /aria-busy="true"/u);
    assert.doesNotMatch(html, /role="textbox"|contenteditable="(?:true|plaintext-only)"|<button|<input/iu);
  }
});

test("freeform-only live questionnaire renders one prompted input and submit action in both layouts", () => {
  for (const presentation of ["full", "compact"] as const) {
    const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
      draft: null,
      mode: "live",
      onDraftChange: (update) => update(draft),
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
  }
});

test("a saved sole question uses its full prompt instead of its old header-derived title", () => {
  const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
    draft: null,
    mode: "live",
    onDraftChange: (update) => update(draft),
    onDraftClear: () => undefined,
    onSubmit: async () => undefined,
    presentation: "full",
    request: {
      ...freeformRequest,
      title: "Component ownership",
    },
    spellCheck: true,
  }));
  assert.doesNotMatch(html, />Component ownership</u);
  assert.doesNotMatch(html, />Choice</u);
  assert.equal(html.match(/<h3[^>]*>([^<]*)<\/h3>/u)?.[1], freeformRequest.questions[0].question);
  assert.equal(html.split(freeformRequest.questions[0].question).length - 1, 1);
});

test("generic single-question framing presents the full prompt once in both layouts", () => {
  const genericRequest = {
    ...freeformRequest,
    title: "Follow-up questions",
    summary: "Codex needs your input before it can continue.",
  };
  for (const presentation of ["full", "compact"] as const) {
    const html = renderToStaticMarkup(createElement(ThreadUserInputRequest, {
      draft: null,
      mode: "preview",
      presentation,
      request: genericRequest,
    }));
    assert.equal(html.match(/<h3[^>]*>([^<]*)<\/h3>/u)?.[1], genericRequest.questions[0].question);
    assert.equal(html.split(genericRequest.questions[0].question).length - 1, 1);
  }
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
    onDraftChange: (update) => update(draft),
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
    onDraftChange: (update) => update(draft),
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
    onDraftChange: (update) => update(draft),
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
    onDraftChange: (update) => update(draft),
    onDraftClear: () => undefined,
    onSubmit: async () => undefined,
    request,
    spellCheck: false,
  }));
  assert.match(html, /data-thread-user-input-presentation="full"/u);
  assert.match(html, /data-thread-questionnaire-submit="true"/u);
});
