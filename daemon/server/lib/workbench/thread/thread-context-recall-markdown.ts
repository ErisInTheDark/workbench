/*
 * Exports:
 * - ThreadRecallWalk: which way a history page reads from its anchor.
 * - renderThreadRecallHistory: fit one chronological narrative window into the response budget, splitting an oversized
 *   record at newline-preferred offsets, with exact older/newer continuation commands.
 * - renderThreadRecallSearch: render ranked search hits with match evidence and one exact `--around` command per hit.
 */
import {
  WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS,
  type WorkbenchThreadRecallKind,
} from "workbench-shared/types";
import type { HistoryPage, HistoryRecord } from "../../../database/history/history-query-contract.ts";

const MIN_PREFERRED_CHUNK_CHARACTERS = 1_000;
const SEARCH_CHROME_CHARACTERS = 3_000;
const SEARCH_HIT_CHROME_CHARACTERS = 300;

export type ThreadRecallWalk =
  | { direction: "latest" }
  | { direction: "before" | "after" | "around"; ref: string; offset: number | null };

interface Chunk { record: HistoryRecord; start: number; end: number }

function commandValue(value: string) {
  return /^[A-Za-z0-9_./:@+-]+$/u.test(value) ? value : JSON.stringify(value);
}

function kindFlags(kinds: readonly WorkbenchThreadRecallKind[] | null) {
  return (kinds ?? []).map(kind => ` --kind ${kind}`).join("");
}

function historyCommand(threadId: string, kinds: readonly WorkbenchThreadRecallKind[] | null, anchor?: { flag: string; ref: string }) {
  return `wb thread recall --thread ${commandValue(threadId)}${kindFlags(kinds)}${anchor ? ` --${anchor.flag} ${commandValue(anchor.ref)}` : ""}`;
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeClosingTagLine(value: string, tagName: string) {
  const closingTag = `</${tagName}>`;
  return value.replace(/\r\n?/gu, "\n").split("\n").map(line => (
    line.trim() === closingTag ? line.replace(closingTag, `&lt;/${tagName}&gt;`) : line
  )).join("\n");
}

function recordTag(record: HistoryRecord, text: string, range?: { start: number; end: number }) {
  const total = record.text.length;
  const rangeAttributes = range && (range.start > 0 || range.end < total)
    ? ` start="${range.start}" end="${range.end}" total="${total}"`
    : "";
  return [
    `<${record.kind} id="${escapeAttribute(`ref:${record.ref}`)}" turn="${escapeAttribute(record.turnId ?? "")}"${record.retained ? " retained=\"true\"" : ""}${rangeAttributes}>`,
    escapeClosingTagLine(text, record.kind),
    `</${record.kind}>`,
  ].join("\n");
}

function join(parts: readonly string[]) {
  return parts.map(part => part.trim()).filter(Boolean).join("\n\n");
}

function header(walk: ThreadRecallWalk, kinds: readonly WorkbenchThreadRecallKind[] | null, threadId: string, warnings: readonly string[]) {
  const kindLine = `Kinds: ${kinds?.join(", ") ?? "all"}`;
  const notes = warnings.map(warning => `Warning: ${warning}`);
  if (walk.direction === "latest") {
    return join([
      "# Thread Recall History",
      "Newest filtered narrative evidence. Older entries may be completed, rejected, or superseded; they are not automatically the current task.",
      kindLine, ...notes,
    ]);
  }
  return join([
    walk.direction === "before" ? "# Thread Recall History — Historical Page" : "# Thread Recall Context",
    "WARNING: Newer thread evidence may be omitted from this page. Do not infer the current objective or approval state from this page alone.",
    kindLine, `Return to newest: \`${historyCommand(threadId, kinds)}\``, ...notes,
  ]);
}

/**
 * The cut keeping the most text between a fixed edge `from` and a movable edge searched toward `to`, preferring
 * a line boundary when that still keeps a useful amount.
 */
function cut(text: string, from: number, to: number, fits: (offset: number) => boolean) {
  const forward = to > from;
  let lower = Math.min(from, to);
  let upper = Math.max(from, to);
  let best = from;
  while (lower <= upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    if (fits(midpoint)) {
      best = midpoint;
      if (forward) lower = midpoint + 1; else upper = midpoint - 1;
    } else if (forward) upper = midpoint - 1; else lower = midpoint + 1;
  }
  if (best === from) throw new Error("Thread Recall could not fit record content inside the safe response budget.");
  if (forward) {
    const newline = text.lastIndexOf("\n", best - 1);
    return newline >= from && newline + 1 - from >= MIN_PREFERRED_CHUNK_CHARACTERS ? newline + 1 : best;
  }
  const newline = text.indexOf("\n", best);
  return newline >= best && from - (newline + 1) >= MIN_PREFERRED_CHUNK_CHARACTERS ? newline + 1 : best;
}

export function renderThreadRecallHistory({ kinds, page, threadId, walk, warnings }: {
  kinds: readonly WorkbenchThreadRecallKind[] | null;
  page: Pick<HistoryPage, "records" | "older" | "newer">;
  threadId: string;
  walk: ThreadRecallWalk;
  warnings: readonly string[];
}) {
  const records = page.records;
  const anchorIndex = walk.direction === "latest" ? -1 : records.findIndex(record => record.ref === walk.ref);
  let chunks: Chunk[] = records.map(record => ({ record, start: 0, end: record.text.length }));
  // A split record re-read by its `ref@offset` continuation shows only the side not yet shown.
  if (walk.direction !== "latest" && walk.offset !== null && anchorIndex >= 0) {
    const anchor = chunks[anchorIndex]!;
    chunks[anchorIndex] = walk.direction === "before" ? { ...anchor, end: Math.min(walk.offset, anchor.end) } : { ...anchor, start: Math.min(walk.offset, anchor.end) };
  }
  let older = page.older;
  let newer = page.newer;
  const render = (shown: readonly Chunk[]) => {
    const first = shown[0];
    const last = shown.at(-1);
    const olderRef = first && first.start > 0 ? `${first.record.ref}@${first.start}` : first && older ? first.record.ref : null;
    const newerRef = last && last.end < last.record.text.length ? `${last.record.ref}@${last.end}` : last && newer ? last.record.ref : null;
    return join([
      header(walk, kinds, threadId, warnings),
      ...(olderRef ? [`Older: \`${historyCommand(threadId, kinds, { flag: "before", ref: olderRef })}\``] : []),
      ...(shown.length ? shown.map(chunk => recordTag(chunk.record, chunk.record.text.slice(chunk.start, chunk.end), chunk)) : ["No records in this window."]),
      ...(newerRef ? ["---", `Newer: \`${historyCommand(threadId, kinds, { flag: "after", ref: newerRef })}\``] : []),
    ]);
  };
  const fits = (shown: readonly Chunk[]) => render(shown).length <= WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS;
  // Keep the anchor's side: newest-first walks drop the oldest records, forward walks the newest, context its farther end.
  const keepNewest = walk.direction === "latest" || walk.direction === "before";
  while (chunks.length > 1 && !fits(chunks)) {
    const anchor = walk.direction === "around" ? chunks.findIndex(chunk => chunk.record.ref === walk.ref) : -1;
    const dropOldest = walk.direction === "around" ? anchor < 0 || anchor > chunks.length - 1 - anchor : keepNewest;
    if (dropOldest) { chunks = chunks.slice(1); older = true; } else { chunks = chunks.slice(0, -1); newer = true; }
  }
  if (chunks.length === 1 && !fits(chunks)) {
    const only = chunks[0]!;
    chunks = keepNewest
      ? [{ ...only, start: cut(only.record.text, only.end, only.start, start => fits([{ ...only, start }])) }]
      : [{ ...only, end: cut(only.record.text, only.start, only.end, end => fits([{ ...only, end }])) }];
  }
  return render(chunks);
}

function searchCommand(threadId: string, query: string, kinds: readonly WorkbenchThreadRecallKind[] | null, limit: number, cursor: string) {
  return `wb thread recall search --thread ${commandValue(threadId)} --query ${commandValue(query)}${kindFlags(kinds)} --limit ${limit} --cursor ${commandValue(cursor)}`;
}

export function renderThreadRecallSearch({ kinds, limit, page, query, threadId }: {
  kinds: readonly WorkbenchThreadRecallKind[] | null;
  limit: number;
  page: Pick<HistoryPage, "records" | "nextCursor" | "search">;
  query: string;
  threadId: string;
}) {
  const summary = page.search!;
  const perHit = Math.floor((WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS - SEARCH_CHROME_CHARACTERS) / Math.max(1, page.records.length)) - SEARCH_HIT_CHROME_CHARACTERS;
  const excerpt = (text: string) => text.length > perHit ? `${text.slice(0, Math.max(0, perHit - 3))}...` : text;
  const markdown = join([
    "# Thread Recall Search",
    `Query: \`${query.replaceAll("`", "\\`")}\` (words in any order)`,
    `Kinds: ${kinds?.join(", ") ?? "all"}`,
    `Matches: ${summary.complete.toLocaleString("en-US")} with every term · ${summary.partial.toLocaleString("en-US")} with some; best first.`,
    `Terms: ${summary.terms.map(term => `${term.term} ${term.hits}`).join(" · ")}`,
    ...(summary.indexed < 1 ? [`Index still building (${Math.floor(summary.indexed * 100)}%); some older records are not searchable yet.`] : []),
    ...summary.corrections.map(correction => `Searched \`${correction.to}\` for \`${correction.from}\`, which matched nothing.`),
    ...(page.records.length ? [] : ["No records match. Try fewer or different words."]),
    ...page.records.flatMap(record => [
      recordTag(record, excerpt(record.excerpt ?? record.text)),
      `Context: \`${historyCommand(threadId, null, { flag: "around", ref: record.ref })}\``,
    ]),
    ...(page.nextCursor ? ["---", `More: \`${searchCommand(threadId, query, kinds, limit, page.nextCursor)}\``] : []),
  ]);
  if (markdown.length > WORKBENCH_THREAD_RECALL_MAX_RESPONSE_CHARACTERS) {
    throw new Error("Thread Recall search page exceeds the safe response budget.");
  }
  return markdown;
}
