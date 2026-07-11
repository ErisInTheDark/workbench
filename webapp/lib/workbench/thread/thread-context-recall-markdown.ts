/*
 * Exports:
 * - renderWorkbenchThreadRecallSearchMarkdown: render bounded native Markdown for recall search results. Keywords: thread recall, search, markdown.
 * - renderWorkbenchThreadRecallExpansionMarkdown: render bounded target-first Markdown for recall expansion. Keywords: thread recall, expand, markdown.
 */

import { WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS } from "../../types.ts";
import type {
  WorkbenchThreadRecallExpansion,
  WorkbenchThreadRecallRecord,
  WorkbenchThreadRecallSearchResult,
} from "./thread-context-recall.ts";

function createTextFence(value: string) {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length));
  return "`".repeat(Math.max(4, longestRun + 1));
}

function renderTextBlock(value: string) {
  const fence = createTextFence(value);
  return `${fence}text\n${value}\n${fence}`;
}

function inlineCode(value: string) {
  const fence = "`".repeat(Math.max(1, ...Array.from(value.matchAll(/`+/gu), (match) => match[0].length + 1)));
  return `${fence}${value}${fence}`;
}

function renderSearchMatch(record: WorkbenchThreadRecallRecord, snippet: string, index: number) {
  return [
    `## Match ${index + 1} — ${record.label}`,
    "",
    `Ref: \`${record.ref}\``,
    `Turn: \`${record.turnId}\``,
    "",
    renderTextBlock(snippet),
  ].join("\n");
}

function renderSearchPage(result: WorkbenchThreadRecallSearchResult, matches: WorkbenchThreadRecallSearchResult["matches"]) {
  return [
    "# Thread Recall Search",
    "",
    `Query: ${inlineCode(result.query)}`,
    `Kinds: ${result.kinds.join(", ")}`,
    `Matches: ${result.totalMatches.toLocaleString("en-US")} total; ${matches.length.toLocaleString("en-US")} shown.`,
    ...matches.map((match, index) => renderSearchMatch(match.record, match.snippet, index)),
    ...(matches.length < result.matches.length
      ? ["---", `${(result.matches.length - matches.length).toLocaleString("en-US")} requested matches were omitted to keep this response transport-safe.`]
      : []),
  ].map((part) => part.trim()).filter(Boolean).join("\n\n");
}

export function renderWorkbenchThreadRecallSearchMarkdown(result: WorkbenchThreadRecallSearchResult) {
  let matches = [...result.matches];
  let markdown = renderSearchPage(result, matches);
  while (markdown.length > WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS && matches.length) {
    matches = matches.slice(0, -1);
    markdown = renderSearchPage(result, matches);
  }
  if (markdown.length > WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS) {
    throw new Error("Thread Recall search metadata exceeds the safe response budget.");
  }
  return markdown;
}

function renderExpansionRecord(record: WorkbenchThreadRecallRecord, targetRef: string, text = record.text) {
  return [
    `## ${record.label}${record.ref === targetRef ? " — Target" : ""}`,
    "",
    `Ref: \`${record.ref}\``,
    `Turn: \`${record.turnId}\``,
    "",
    text,
  ].join("\n");
}

function renderExpansionPage(records: readonly WorkbenchThreadRecallRecord[], targetRef: string) {
  return [
    "# Thread Recall Expansion",
    "",
    `Target: \`${targetRef}\``,
    ...records.map((record) => renderExpansionRecord(record, targetRef)),
  ].map((part) => part.trim()).filter(Boolean).join("\n\n");
}

function renderTruncatedTarget(record: WorkbenchThreadRecallRecord, maxCharacters: number) {
  const createCandidate = (previewCharacters: number) => {
    const preview = record.text.slice(0, previewCharacters);
    return {
      ...record,
      text: [
        `Showing the first ${preview.length.toLocaleString("en-US")} of ${record.text.length.toLocaleString("en-US")} target characters.`,
        "",
        renderTextBlock(preview),
        "",
        `[${(record.text.length - preview.length).toLocaleString("en-US")} target characters omitted to keep this response transport-safe.]`,
      ].join("\n"),
    };
  };

  let lower = 0;
  let upper = record.text.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    if (renderExpansionPage([createCandidate(midpoint)], record.ref).length <= maxCharacters) {
      lower = midpoint;
    } else {
      upper = midpoint - 1;
    }
  }
  return createCandidate(lower);
}

export function renderWorkbenchThreadRecallExpansionMarkdown(
  expansion: WorkbenchThreadRecallExpansion,
  maxCharacters: number,
) {
  const target = expansion.records.find((record) => record.ref === expansion.targetRef);
  if (!target) {
    throw new Error(`Thread Recall expansion target disappeared: ${expansion.targetRef}`);
  }

  const safeMaximum = Math.min(maxCharacters, WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS);
  const orderByRef = new Map(expansion.records.map((record, index) => [record.ref, index]));
  const targetIndex = orderByRef.get(expansion.targetRef) ?? 0;
  const targetRecord = renderExpansionPage([target], expansion.targetRef).length <= safeMaximum
    ? target
    : renderTruncatedTarget(target, safeMaximum);
  let selected = [targetRecord];
  const candidates = expansion.records
    .filter((record) => record.ref !== expansion.targetRef)
    .sort((left, right) => (
      Math.abs((orderByRef.get(left.ref) ?? 0) - targetIndex)
      - Math.abs((orderByRef.get(right.ref) ?? 0) - targetIndex)
    ));
  for (const candidate of candidates) {
    const next = [...selected, candidate].sort((left, right) => (
      (orderByRef.get(left.ref) ?? 0) - (orderByRef.get(right.ref) ?? 0)
    ));
    if (renderExpansionPage(next, expansion.targetRef).length <= safeMaximum) {
      selected = next;
    }
  }

  const markdown = renderExpansionPage(selected, expansion.targetRef);
  if (markdown.length > safeMaximum) {
    throw new Error("Thread Recall expansion could not fit inside the requested response budget.");
  }
  return markdown;
}
