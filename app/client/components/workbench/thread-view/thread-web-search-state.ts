/*
 * Exports:
 * - isNonEmptyString: narrow non-empty web-search strings after trimming. Keywords: web search, string, guard.
 * - isThreadWebSearchPlaceholder: detect empty in-progress web-search placeholders. Keywords: workbench, thread, web search, placeholder.
 * - getThreadWebSearchLiveLabel: derive the live activity label for a web-search item. Keywords: workbench, thread, web search, live.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;

export function isNonEmptyString(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

export function isThreadWebSearchPlaceholder(item: WebSearchItem) {
  return (!item.action || item.action.type === "other") && !isNonEmptyString(item.query);
}

export function getThreadWebSearchLiveLabel(item: WebSearchItem) {
  switch (item.action?.type) {
    case "search":
      return "Searching web...";
    case "openPage":
      return "Opening page...";
    case "findInPage":
      return "Searching page...";
    default:
      return "Using web...";
  }
}
