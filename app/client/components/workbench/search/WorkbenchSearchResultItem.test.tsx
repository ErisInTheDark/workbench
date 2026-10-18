/* No exports. Protect thread fallback text when sidebar facts are unavailable. */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import WorkbenchSearchResultItem from "./WorkbenchSearchResultItem";

test("thread fallback hides project identity while retaining a matched message excerpt", () => {
  const base = {
    harnessId: "codex", id: "thread:one", kind: "thread" as const,
    projectId: "5de07ba4-bf29-4cfb-bb77-2a2e9c8ce9be", threadId: "one", title: "rework sidebar",
  };
  const render = (detail: string) => renderToStaticMarkup(createElement(WorkbenchSearchResultItem, {
    id: "result", onActivate: () => {}, result: { ...base, detail }, selected: false,
  }));

  const titleMatch = render(base.projectId);
  assert.match(titleMatch, /rework sidebar/u);
  assert.doesNotMatch(titleMatch, /5de07ba4-bf29-4cfb-bb77-2a2e9c8ce9be/u);
  assert.match(render("You: changed the button"), /You: changed the button/u);
});
