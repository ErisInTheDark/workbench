/*
 * Exports:
 * - isNonEmptyString: narrow non-empty web-search strings after trimming. Keywords: web search, string, guard.
 * - isThreadWebSearchPlaceholder: detect empty in-progress web-search placeholders. Keywords: workbench, thread, web search, placeholder.
 */

import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";

type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;

export function isNonEmptyString(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

export function isThreadWebSearchPlaceholder(item: WebSearchItem) {
  return (!item.action || item.action.type === "other") && !isNonEmptyString(item.query);
}
