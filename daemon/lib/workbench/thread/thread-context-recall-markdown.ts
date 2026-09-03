/*
 * Exports:
 * - renderWorkbenchThreadRecallHistoryMarkdown: render a filtered newest-to-oldest history page with stable continuation commands. Keywords: thread recall, history, pagination.
 * - renderWorkbenchThreadRecallSearchMarkdown: render one newest-to-oldest search page with tagged snippets and an exact older-results command. Keywords: search, pagination, tags.
 * - renderWorkbenchThreadRecallExpansionMarkdown: render one fixed-budget record-content page and its exact next command. Keywords: expansion, cursor, chunking.
 */

import {
  WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS,
  type WorkbenchThreadRecallKind,
} from "workbench-shared/types";
import {
  createWorkbenchThreadRecallCursor,
  readWorkbenchThreadRecallCursor,
  type WorkbenchThreadRecallExpansion,
  type WorkbenchThreadRecallRecord,
  type WorkbenchThreadRecallSearchResult,
} from "./thread-context-recall.ts";

const MIN_PREFERRED_HISTORY_CHUNK_CHARACTERS = 1_000;

interface ThreadRecallChunk {
  end: number;
  record: WorkbenchThreadRecallRecord;
  start: number;
}

function commandValue(value: string) {
  return /^[A-Za-z0-9_./:@+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function kindFlags(kinds: readonly WorkbenchThreadRecallKind[]) {
  return kinds.map((kind) => ` --kind ${kind}`).join("");
}

function historyCommand(threadId: string, kinds: readonly WorkbenchThreadRecallKind[], before?: string | null) {
  return `wb thread recall --thread ${commandValue(threadId)}${kindFlags(kinds)}${before ? ` --before ${commandValue(before)}` : ""}`;
}

function searchCommand(result: WorkbenchThreadRecallSearchResult, threadId: string, before?: string | null) {
  return `wb thread recall search --thread ${commandValue(threadId)} --query ${commandValue(result.query)}${kindFlags(result.kinds)} --limit ${result.limit}${before ? ` --before ${commandValue(before)}` : ""}`;
}

function expandCommand(threadId: string, ref: string, cursor?: string | null) {
  return `wb thread recall expand --thread ${commandValue(threadId)} --ref ${commandValue(ref)}${cursor ? ` --cursor ${commandValue(cursor)}` : ""}`;
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeClosingTagLine(value: string, tagName: string) {
  const closingTag = `</${tagName}>`;
  return value.replace(/\r\n?/gu, "\n").split("\n").map((line) => (
    line.trim() === closingTag ? line.replace(closingTag, `&lt;/${tagName}&gt;`) : line
  )).join("\n");
}

function renderRecallRecordTag(
  record: WorkbenchThreadRecallRecord,
  text: string,
  range?: { end: number; start: number; total: number },
) {
  const rangeAttributes = range && (range.start > 0 || range.end < range.total)
    ? ` start="${range.start}" end="${range.end}" total="${range.total}"`
    : "";
  return [
    `<${record.kind} id="${escapeAttribute(`ref:${record.ref}`)}" turn="${escapeAttribute(record.turnId)}"${rangeAttributes}>`,
    escapeClosingTagLine(text, record.kind),
    `</${record.kind}>`,
  ].join("\n");
}

function continuationBeforeForChunk(records: readonly WorkbenchThreadRecallRecord[], chunk: ThreadRecallChunk) {
  if (chunk.start > 0) {
    return createWorkbenchThreadRecallCursor(chunk.record.ref, chunk.start);
  }
  const recordIndex = records.findIndex((record) => record.ref === chunk.record.ref);
  return recordIndex > 0 ? chunk.record.ref : null;
}

function renderHistoryPage({
  before,
  chunks,
  kinds,
  records,
  threadId,
}: {
  before: string | null;
  chunks: readonly ThreadRecallChunk[];
  kinds: readonly WorkbenchThreadRecallKind[];
  records: readonly WorkbenchThreadRecallRecord[];
  threadId: string;
}) {
  const historical = before !== null;
  const continuationBefore = chunks[0] ? continuationBeforeForChunk(records, chunks[0]) : null;
  const header = historical
    ? [
      "# Thread Recall History — Historical Page",
      "",
      "WARNING: Newer thread evidence is intentionally omitted from this page. Do not infer the current objective or approval state from this page alone.",
      "",
      `Kinds: ${kinds.join(", ")}`,
      `Return to newest: \`${historyCommand(threadId, kinds)}\``,
    ].join("\n")
    : [
      "# Thread Recall History",
      "",
      "Newest filtered narrative evidence. Older entries may be completed, rejected, or superseded; they are not automatically the current task.",
      "",
      `Kinds: ${kinds.join(", ")}`,
    ].join("\n");
  return [
    header,
    ...chunks.map((chunk) => renderRecallRecordTag(
      chunk.record,
      chunk.record.text.slice(chunk.start, chunk.end),
      { end: chunk.end, start: chunk.start, total: chunk.record.text.length },
    )),
    ...(continuationBefore ? [
      "---",
      `Previous page: \`${historyCommand(threadId, kinds, continuationBefore)}\``,
    ] : []),
  ].map((part) => part.trim()).filter(Boolean).join("\n\n");
}

function resolveHistoryEnd(records: readonly WorkbenchThreadRecallRecord[], before: string | null) {
  if (before === null) {
    const index = records.length - 1;
    return { end: records[index]?.text.length ?? 0, index };
  }
  const cursor = readWorkbenchThreadRecallCursor(before);
  if (cursor) {
    const index = records.findIndex((record) => record.ref === cursor.ref);
    if (index < 0 || cursor.offset > records[index]!.text.length) {
      throw new Error(`Unknown Thread Recall history cursor: ${before}`);
    }
    return cursor.offset === 0
      ? { end: records[index - 1]?.text.length ?? 0, index: index - 1 }
      : { end: cursor.offset, index };
  }
  const index = records.findIndex((record) => record.ref === before);
  if (index < 0) {
    throw new Error(`Unknown Thread Recall history ref: ${before}`);
  }
  return { end: records[index - 1]?.text.length ?? 0, index: index - 1 };
}

function findHistoryChunkStart({
  before,
  end,
  kinds,
  record,
  records,
  threadId,
}: {
  before: string | null;
  end: number;
  kinds: readonly WorkbenchThreadRecallKind[];
  record: WorkbenchThreadRecallRecord;
  records: readonly WorkbenchThreadRecallRecord[];
  threadId: string;
}) {
  const fits = (start: number) => renderHistoryPage({
    before,
    chunks: [{ end, record, start }],
    kinds,
    records,
    threadId,
  }).length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS;
  let lower = 0;
  let upper = Math.max(0, end - 1);
  let start = end;
  while (lower <= upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (fits(midpoint)) {
      start = midpoint;
      upper = midpoint - 1;
    } else {
      lower = midpoint + 1;
    }
  }
  if (start >= end) {
    throw new Error("Thread Recall could not fit record content inside the safe response budget.");
  }
  const newline = record.text.indexOf("\n", start);
  return newline >= start && end - (newline + 1) >= MIN_PREFERRED_HISTORY_CHUNK_CHARACTERS
    ? newline + 1
    : start;
}

export function renderWorkbenchThreadRecallHistoryMarkdown(
  records: readonly WorkbenchThreadRecallRecord[],
  {
    before = null,
    kinds,
    threadId,
  }: {
    before?: string | null;
    kinds: readonly WorkbenchThreadRecallKind[];
    threadId: string;
  },
) {
  const resolvedEnd = resolveHistoryEnd(records, before);
  let index = resolvedEnd.index;
  let end = resolvedEnd.end;
  let chunks: ThreadRecallChunk[] = [];
  while (index >= 0) {
    const record = records[index]!;
    const candidateChunk = { end, record, start: 0 };
    const candidateChunks = [candidateChunk, ...chunks];
    if (renderHistoryPage({ before, chunks: candidateChunks, kinds, records, threadId }).length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS) {
      chunks = candidateChunks;
      index -= 1;
      end = records[index]?.text.length ?? 0;
      continue;
    }
    if (chunks.length) break;
    const start = findHistoryChunkStart({ before, end, kinds, record, records, threadId });
    chunks = [{ end, record, start }];
    break;
  }
  const markdown = renderHistoryPage({ before, chunks, kinds, records, threadId });
  if (markdown.length > WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS) {
    throw new Error("Thread Recall could not render a history page inside the safe response budget.");
  }
  return markdown;
}

function renderSearchPage(result: WorkbenchThreadRecallSearchResult, threadId: string) {
  const oldestMatchRef = result.matches.at(-1)?.record.ref ?? null;
  return [
    "# Thread Recall Search",
    "",
    `Query: \`${result.query.replaceAll("`", "\\`")}\``,
    `Kinds: ${result.kinds.join(", ")}`,
    `Matches: ${result.totalMatches.toLocaleString("en-US")} total; ${result.matches.length.toLocaleString("en-US")} shown on this newest-first page.`,
    ...result.matches.flatMap((match) => [
      renderRecallRecordTag(match.record, match.snippet),
      `Expand: \`${expandCommand(threadId, match.record.ref)}\``,
    ]),
    ...(result.hasOlderMatches && oldestMatchRef ? [
      "---",
      `Previous search page: \`${searchCommand(result, threadId, oldestMatchRef)}\``,
    ] : []),
  ].map((part) => part.trim()).filter(Boolean).join("\n\n");
}

export function renderWorkbenchThreadRecallSearchMarkdown(
  result: WorkbenchThreadRecallSearchResult,
  threadId: string,
) {
  let pageResult = result;
  let markdown = renderSearchPage(pageResult, threadId);
  while (markdown.length > WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS && pageResult.matches.length > 1) {
    pageResult = {
      ...pageResult,
      hasOlderMatches: true,
      matches: pageResult.matches.slice(0, -1),
    };
    markdown = renderSearchPage(pageResult, threadId);
  }
  if (markdown.length > WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS) {
    throw new Error("Thread Recall search page exceeds the safe response budget.");
  }
  return markdown;
}

function renderExpansionPage(
  expansion: WorkbenchThreadRecallExpansion,
  threadId: string,
  end: number,
) {
  const nextCursor = end < expansion.record.text.length
    ? createWorkbenchThreadRecallCursor(expansion.record.ref, end)
    : null;
  return [
    "# Thread Recall Record",
    "",
    `Ref: \`${expansion.record.ref}\``,
    renderRecallRecordTag(
      expansion.record,
      expansion.record.text.slice(expansion.cursor, end),
      { end, start: expansion.cursor, total: expansion.record.text.length },
    ),
    ...(nextCursor ? [
      "---",
      `Next page: \`${expandCommand(threadId, expansion.record.ref, nextCursor)}\``,
    ] : []),
  ].map((part) => part.trim()).filter(Boolean).join("\n\n");
}

export function renderWorkbenchThreadRecallExpansionMarkdown(
  expansion: WorkbenchThreadRecallExpansion,
  threadId: string,
) {
  let lower = Math.min(expansion.record.text.length, expansion.cursor + 1);
  let upper = expansion.record.text.length;
  let end = expansion.cursor;
  while (lower <= upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (renderExpansionPage(expansion, threadId, midpoint).length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS) {
      end = midpoint;
      lower = midpoint + 1;
    } else {
      upper = midpoint - 1;
    }
  }
  if (end <= expansion.cursor && expansion.cursor < expansion.record.text.length) {
    throw new Error("Thread Recall could not fit expansion content inside the safe response budget.");
  }
  if (end < expansion.record.text.length) {
    const newline = expansion.record.text.lastIndexOf("\n", end - 1);
    if (newline >= expansion.cursor) end = newline + 1;
  }
  const markdown = renderExpansionPage(expansion, threadId, end);
  if (markdown.length > WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS) {
    throw new Error("Thread Recall expansion page exceeds the safe response budget.");
  }
  return markdown;
}
