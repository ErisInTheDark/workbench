/*
 * Exports:
 * - NativePathToolKind: provider-neutral native file operation kinds with shared summary grammar.
 * - nativePathToolSummary: summarise one structured native file call without parsing code or shell text.
 * - nativeReadSummary: summarise a native read from its path and optional line or page range.
 */
import { createEmptyCommandSummaryStats, summarizeDisplayParts } from "./helpers";
import type { ThreadCommandDisplayPart, ThreadCommandSummaryDisplay } from "./types";

export type NativePathToolKind = "read" | "search" | "list" | "edit" | "write";

const definitions: Record<NativePathToolKind, { done: string; ongoing: string; stat?: "readFiles" | "searchedFiles" | "listedFiles" }> = {
  read: { done: "Read", ongoing: "Reading", stat: "readFiles" },
  search: { done: "Searched", ongoing: "Searching", stat: "searchedFiles" },
  list: { done: "Listed", ongoing: "Listing", stat: "listedFiles" },
  edit: { done: "Edited", ongoing: "Editing" },
  write: { done: "Wrote", ongoing: "Writing" },
};

export function nativePathToolSummary(input: {
  claimedBy: string;
  kind: NativePathToolKind;
  path: string | null;
  pattern?: { text: string; syntax: "regex" | "literal" } | null;
}): ThreadCommandSummaryDisplay {
  const definition = definitions[input.kind];
  const target: ThreadCommandDisplayPart[] = [];
  if (input.pattern) {
    target.push({ type: "pattern", pattern: input.pattern.text, syntax: input.pattern.syntax }, { type: "text", text: " in " });
  }
  target.push({ type: "path", path: input.path ?? "." });
  const summaryParts: ThreadCommandDisplayPart[] = [{ type: "text", text: `${definition.done} ` }, ...target];
  const ongoingSummaryParts: ThreadCommandDisplayPart[] = [{ type: "text", text: `${definition.ongoing} ` }, ...target];
  const stats = createEmptyCommandSummaryStats();
  if (definition.stat) stats[definition.stat] = 1;
  else stats.otherCommands = 1;
  return { claimedBy: input.claimedBy, omitFromDisplay: false, shell: null, showShell: false,
    summaryKind: "matched", summaryStats: stats, summaryParts, ongoingSummaryParts,
    summaryText: summarizeDisplayParts(summaryParts), ongoingSummaryText: summarizeDisplayParts(ongoingSummaryParts) };
}

export function nativeReadSummary(input: {
  claimedBy: string;
  path: string;
  offset?: number | null;
  limit?: number | null;
  pages?: string | null;
}): ThreadCommandSummaryDisplay {
  const definition = definitions.read;
  const range = readRangeText(input);
  const target: ThreadCommandDisplayPart[] = range
    ? [{ type: "text", text: `${range} of ` }, { type: "path", path: input.path }]
    : [{ type: "path", path: input.path }];
  const summaryParts: ThreadCommandDisplayPart[] = [{ type: "text", text: `${definition.done} ` }, ...target];
  const ongoingSummaryParts: ThreadCommandDisplayPart[] = [{ type: "text", text: `${definition.ongoing} ` }, ...target];
  const stats = createEmptyCommandSummaryStats();
  stats.readFiles = 1;
  return { claimedBy: input.claimedBy, omitFromDisplay: false, shell: null, showShell: false,
    summaryKind: "matched", summaryStats: stats, summaryParts, ongoingSummaryParts,
    summaryText: summarizeDisplayParts(summaryParts), ongoingSummaryText: summarizeDisplayParts(ongoingSummaryParts) };
}

/** Claude's Read tool reports a whole file, a line window via offset/limit, or PDF pages via pages. */
function readRangeText(input: { offset?: number | null; limit?: number | null; pages?: string | null }) {
  const offset = typeof input.offset === "number" ? input.offset : null;
  const limit = typeof input.limit === "number" ? input.limit : null;
  if (input.pages) return `pages ${input.pages}`;
  if (offset !== null && limit !== null) return `lines ${offset}-${offset + limit - 1}`;
  if (offset !== null) return `from line ${offset}`;
  if (limit !== null) return `first ${limit} lines`;
  return null;
}
