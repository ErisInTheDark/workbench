/*
 * Exports:
 * - No production exports; Node tests lock user-owned disclosure toggles for completed web searches. Keywords: thread, web search, disclosure, toggle.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isValidElement } from "react";

import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem";
import ThreadWebSearchItem from "./ThreadWebSearchItem";

type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;

test("completed web searches leave disclosure toggles user-owned", () => {
  const item: WebSearchItem = {
    action: { queries: ["needle"], query: "needle", type: "search" },
    id: "web-search-one",
    query: "needle",
    results: null,
    type: "webSearch",
  };
  const disclosure = ThreadWebSearchItem({ item });

  assert.equal(isValidElement<{ defaultOpen?: boolean; open?: boolean }>(disclosure), true);
  if (!isValidElement<{ defaultOpen?: boolean; open?: boolean }>(disclosure)) return;
  assert.equal(disclosure.props.defaultOpen, false);
  assert.equal(disclosure.props.open, undefined);
});
