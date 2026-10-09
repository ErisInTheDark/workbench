/*
 * Exports:
 * - RipgrepSearchInput/RipgrepSearchResult: worker request and response contracts.
 * - searchRipgrepFiles: read, scan and format candidate files with result and filesize guards.
 */
import fs from "node:fs/promises";

import type { RipgrepQuery } from "workbench-shared/workbench/ripgrep/ripgrep-arguments";
import type { RipgrepCandidate } from "./ripgrep-candidates";
import { compileRipgrepMatcher, RipgrepPatternError } from "./ripgrep-matcher";
import { formatRipgrepFile, formatRipgrepSize, type RipgrepOutputEntry } from "./ripgrep-output";

export interface RipgrepSearchInput {
  query: RipgrepQuery;
  files: RipgrepCandidate[];
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

export async function searchRipgrepFiles({ query, files }: RipgrepSearchInput): Promise<RipgrepSearchResult> {
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
