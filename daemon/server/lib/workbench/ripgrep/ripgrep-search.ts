/*
 * Exports:
 * - RipgrepSearchInput/RipgrepSearchResult: worker request and response contracts.
 * - runRipgrepSearch: collect a query's candidates and search them, appending collection warnings to the output; an
 *   exceeded file budget or no searchable root is an invalid query.
 */
import fs from "node:fs/promises";

import type { RipgrepQuery } from "workbench-shared/workbench/ripgrep/ripgrep-arguments";
import { collectRipgrepCandidates, RipgrepFileBudgetExceeded, type RipgrepCandidate } from "./ripgrep-candidates";
import { compileRipgrepMatcher, RipgrepPatternError } from "./ripgrep-matcher";
import { formatRipgrepFile, formatRipgrepSize, type RipgrepOutputEntry } from "./ripgrep-output";

/** Candidates are collected beside the search, so a huge enumeration never crosses into the caller's thread. */
export interface RipgrepSearchInput {
  query: RipgrepQuery;
  cwd: string;
  prefetchWarnings: Record<string, string>;
}

export type RipgrepSearchResult =
  | { kind: "output"; output: string }
  | { kind: "invalid"; message: string }
  | { kind: "failed"; message: string };

type FileContent =
  | { kind: "text"; text: string }
  | { kind: "skipped" }
  | { kind: "oversized" }
  | { kind: "unreadable" };

const READ_BATCH_SIZE = 32;
const BINARY_SNIFF_BYTES = 8192;
// Tracked-but-deleted files and submodule directories are expected in git listings.
const EXPECTED_MISSING_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);
const UNREADABLE_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);

async function readFileContent(file: RipgrepCandidate, query: RipgrepQuery): Promise<FileContent> {
  try {
    const stats = await fs.lstat(file.absolutePath);
    if (!stats.isFile()) return { kind: "skipped" };
    if (stats.size > query.maxFilesize) return { kind: "oversized" };
    const buffer = await fs.readFile(file.absolutePath);
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return { kind: "text", text: new TextDecoder("utf-16le").decode(buffer.subarray(2)) };
    if (!query.binary && buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "skipped" };
    return { kind: "text", text: new TextDecoder("utf-8").decode(buffer) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (EXPECTED_MISSING_CODES.has(code)) return { kind: "skipped" };
    if (UNREADABLE_CODES.has(code)) return { kind: "unreadable" };
    throw error;
  }
}

function joinLines(lines: readonly string[]) {
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function truncationNotice(query: RipgrepQuery) {
  return `[wb rg: output truncated at ${query.maxResults} results; narrow the search or raise --max-results (0 = unlimited)]`;
}

export async function runRipgrepSearch({ query, cwd, prefetchWarnings }: RipgrepSearchInput): Promise<RipgrepSearchResult> {
  let candidates;
  try {
    // The worker owning this search is terminated to cancel it, so collection needs no abort of its own.
    candidates = await collectRipgrepCandidates(query, cwd, new AbortController().signal, prefetchWarnings);
  } catch (error) {
    if (error instanceof RipgrepFileBudgetExceeded) return { kind: "invalid", message: error.message };
    throw error;
  }
  if (!candidates.searchedRoots) return { kind: "invalid", message: candidates.warnings.join("\n") };
  const result = await searchRipgrepFiles(query, candidates.files);
  if (result.kind !== "output" || !candidates.warnings.length) return result;
  return { kind: "output", output: `${result.output}${candidates.warnings.join("\n")}\n` };
}

async function searchRipgrepFiles(query: RipgrepQuery, files: readonly RipgrepCandidate[]): Promise<RipgrepSearchResult> {
  const cap = query.maxResults || Number.POSITIVE_INFINITY;
  if (query.mode === "files") {
    const lines = files.slice(0, Math.min(files.length, cap)).map(file => file.displayPath);
    if (files.length > cap) lines.push(truncationNotice(query));
    return { kind: "output", output: joinLines(lines) };
  }

  let matcher;
  try {
    matcher = compileRipgrepMatcher(query);
  } catch (error) {
    if (error instanceof RipgrepPatternError) return { kind: "invalid", message: error.message };
    throw error;
  }

  const lines: string[] = [];
  let results = 0;
  let truncated = false;
  let oversized = 0;
  let unreadable = 0;
  let printedFiles = 0;
  const hasContext = query.beforeContext > 0 || query.afterContext > 0;
  const append = (entries: readonly RipgrepOutputEntry[]) => {
    if (printedFiles > 0 && query.mode === "lines") {
      if (query.heading && query.withFilename) lines.push("");
      else if (hasContext) lines.push("--");
    }
    printedFiles += 1;
    for (const entry of entries) {
      if (entry.result) {
        if (results >= cap) {
          truncated = true;
          return;
        }
        results += 1;
      }
      lines.push(entry.text);
    }
  };

  for (let start = 0; start < files.length && !truncated; start += READ_BATCH_SIZE) {
    const batch = files.slice(start, start + READ_BATCH_SIZE);
    const contents = await Promise.all(batch.map(file => readFileContent(file, query)));
    for (let index = 0; index < batch.length && !truncated; index += 1) {
      const content = contents[index]!;
      if (content.kind === "oversized") oversized += 1;
      if (content.kind === "unreadable") unreadable += 1;
      if (content.kind !== "text") continue;
      const entries = formatRipgrepFile(query, batch[index]!.displayPath, matcher.scan(content.text));
      if (entries.length) append(entries);
    }
  }

  const notices: string[] = [];
  if (truncated) notices.push(truncationNotice(query));
  if (oversized) {
    notices.push(`[wb rg: skipped ${oversized} files over ${formatRipgrepSize(query.maxFilesize)}; raise --max-filesize to search them]`);
  }
  if (unreadable) notices.push(`[wb rg: could not read ${unreadable} files (permission denied or locked)]`);
  if (notices.length && lines.length) lines.push("");
  return { kind: "output", output: joinLines([...lines, ...notices]) };
}
