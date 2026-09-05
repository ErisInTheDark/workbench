/*
 * Keywords: patch, observation, hunks, uncertainty.
 * Exports:
 * - FileObservation: bounded filesystem observation supplied by the caller.
 * - FileChangeHunkAnalysis/FileChangeAnalysis: requested-change evidence, not writer attribution.
 * - analyseFileChange: compare an attempted change with current file observations.
 */
import type { FileUpdateChange } from "../../codex/generated/app-server/v2/FileUpdateChange.ts";
import { parseUnifiedDiff, type UnifiedDiffHunk } from "./unified-diff.ts";

export type FileObservation =
  | { kind: "file"; text: string }
  | { kind: "missing" }
  | { kind: "unavailable"; reason: string };

export interface FileChangeHunkAnalysis {
  additions: number;
  candidates: number[];
  currentEnd: number | null;
  currentStart: number | null;
  deletions: number;
  index: number;
  newStart: number | null;
  oldStart: number | null;
  outcome: "present" | "unapplied" | "uncertain";
  reason: string | null;
}

export interface FileChangeAnalysis {
  additions: number;
  deletions: number;
  detail: string | null;
  hunks: FileChangeHunkAnalysis[];
  outcome: "present" | "unapplied" | "partial" | "copied" | "uncertain";
}

function uncertain(detail: string): FileChangeAnalysis {
  return { additions: 0, deletions: 0, detail, hunks: [], outcome: "uncertain" };
}

function textLines(text: string) {
  const normalized = text.replace(/\r\n/g, "\n");
  return {
    lines: normalized === "" ? [] : (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n"),
    terminated: normalized.endsWith("\n"),
  };
}

function hunkSide(hunk: UnifiedDiffHunk, side: "old" | "new") {
  const lines: string[] = [];
  let noNewline = false;
  let invalid = false;
  for (const [index, row] of hunk.lines.entries()) {
    const belongs = (type: typeof row.type | undefined) => type === "context" || type === (side === "old" ? "deletion" : "addition");
    if (belongs(row.type)) {
      if (noNewline) invalid = true;
      lines.push(row.text);
    } else if (row.text === "\\ No newline at end of file" && belongs(hunk.lines[index - 1]?.type)) {
      noNewline = true;
    }
  }
  return { invalid, lines, noNewline };
}

// Prefix matching keeps repeated source lines linear rather than rescanning each candidate.
function findMatches(file: ReturnType<typeof textLines>, side: ReturnType<typeof hunkSide>) {
  if (side.invalid) return [];
  const pattern = side.lines;
  if (!pattern.length) return file.lines.length ? [] : [0];
  const prefix = new Array<number>(pattern.length).fill(0);
  for (let index = 1, length = 0; index < pattern.length; index += 1) {
    while (length && pattern[index] !== pattern[length]) length = prefix[length - 1]!;
    if (pattern[index] === pattern[length]) length += 1;
    prefix[index] = length;
  }
  const matches: number[] = [];
  for (let index = 0, length = 0; index < file.lines.length; index += 1) {
    while (length && file.lines[index] !== pattern[length]) length = prefix[length - 1]!;
    if (file.lines[index] === pattern[length]) length += 1;
    if (length !== pattern.length) continue;
    const atEnd = index === file.lines.length - 1;
    if (side.noNewline ? atEnd && !file.terminated : !atEnd || file.terminated) {
      matches.push(index + 1 - length);
      if (matches.length > 32) break;
    }
    length = prefix[length - 1]!;
  }
  return matches;
}

function analyseHunk(hunk: UnifiedDiffHunk, index: number, file: ReturnType<typeof textLines>): FileChangeHunkAnalysis {
  const base: FileChangeHunkAnalysis = {
    additions: 0, candidates: [], currentEnd: null, currentStart: null, deletions: 0,
    index, newStart: hunk.newStart, oldStart: hunk.oldStart,
    outcome: "uncertain", reason: "Incomplete or unsupported hunk.",
  };
  if (!hunk.complete || !hunk.lines.some(({ type }) => type === "addition" || type === "deletion")) return base;
  const old = hunkSide(hunk, "old");
  const next = hunkSide(hunk, "new");
  const oldMatches = findMatches(file, old);
  const newMatches = findMatches(file, next);
  base.candidates = [...new Set([...oldMatches, ...newMatches])].sort((a, b) => a - b).slice(0, 32).map((line) => line + 1);
  if (oldMatches.length > 32 || newMatches.length > 32) return { ...base, reason: "Too many matching locations." };
  // An insertion can retain all old context inside its new sequence (and vice versa for deletion).
  const uncontained = (matches: number[], size: number, other: number[], otherSize: number) => matches.filter((start) => !(
    otherSize > size && other.some((otherStart) => start >= otherStart && start + size <= otherStart + otherSize)
  ));
  const before = uncontained(oldMatches, old.lines.length, newMatches, next.lines.length);
  const after = uncontained(newMatches, next.lines.length, oldMatches, old.lines.length);
  const applied = after.length === 1 && before.length === 0;
  const unapplied = before.length === 1 && after.length === 0;
  if (!applied && !unapplied) return {
    ...base,
    reason: old.invalid || next.invalid ? "Invalid final-newline evidence."
      : before.length || after.length ? "Repeated or conflicting contextual matches." : "No complete contextual match.",
  };
  const start = (applied ? after : before)[0]!;
  return {
    ...base,
    additions: applied ? hunk.lines.filter(({ type }) => type === "addition").length : 0,
    deletions: applied ? hunk.lines.filter(({ type }) => type === "deletion").length : 0,
    currentStart: start + 1,
    currentEnd: start + (applied ? next : old).lines.length,
    outcome: applied ? "present" : "unapplied",
    reason: null,
  };
}

function analyseUpdate(diff: string, text: string): FileChangeAnalysis {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.hunks.length || parsed.hunks.length > 256) return uncertain("Missing or oversized hunk evidence.");
  const file = textLines(text);
  const hunks = parsed.hunks.map((hunk, index) => analyseHunk(hunk, index, file));
  const conflicts = new Set<number>();
  for (let left = 0; left < hunks.length; left += 1) {
    for (let right = left + 1; right < hunks.length; right += 1) {
      const before = hunks[left]!;
      const after = hunks[right]!;
      if (before.currentEnd !== null && after.currentStart !== null && before.currentEnd >= after.currentStart) {
        conflicts.add(left);
        conflicts.add(right);
      }
    }
  }
  for (const index of conflicts) {
    hunks[index] = {
      ...hunks[index]!, additions: 0, deletions: 0, currentStart: null, currentEnd: null,
      outcome: "uncertain", reason: "Hunk evidence overlaps or appears out of order.",
    };
  }
  const present = hunks.filter(({ outcome }) => outcome === "present").length;
  const unapplied = hunks.filter(({ outcome }) => outcome === "unapplied").length;
  return {
    additions: hunks.reduce((sum, hunk) => sum + hunk.additions, 0),
    deletions: hunks.reduce((sum, hunk) => sum + hunk.deletions, 0),
    detail: hunks.some(({ outcome }) => outcome === "uncertain") ? "Some requested hunks could not be established." : null,
    hunks,
    outcome: present === hunks.length ? "present" : unapplied === hunks.length ? "unapplied" : present ? "partial" : "uncertain",
  };
}

export function analyseFileChange(
  change: FileUpdateChange,
  observations: ReadonlyMap<string, FileObservation>,
): FileChangeAnalysis {
  const source = observations.get(change.path);
  if (!source) return uncertain("No source observation.");
  if (source.kind === "unavailable") return uncertain(source.reason);
  const result = (outcome: FileChangeAnalysis["outcome"], additions = 0, deletions = 0): FileChangeAnalysis => ({
    additions, deletions, detail: null, hunks: [], outcome,
  });
  if (change.kind.type === "add") {
    if (source.kind === "missing") return result("unapplied");
    return source.text.replace(/\r\n/g, "\n") === change.diff.replace(/\r\n/g, "\n")
      ? result("present", textLines(change.diff).lines.length)
      : uncertain("Existing content does not equal the complete requested addition.");
  }
  if (change.kind.type === "delete") {
    return source.kind === "missing" ? result("present", 0, textLines(change.diff).lines.length) : result("unapplied");
  }
  const destinationPath = change.kind.move_path;
  if (!destinationPath) {
    return source.kind === "file" ? analyseUpdate(change.diff, source.text) : uncertain("Update target is missing.");
  }
  if (destinationPath === change.path) return uncertain("Move source and destination are the same path.");
  const destination = observations.get(destinationPath);
  if (!destination) return uncertain("No destination observation.");
  if (destination.kind === "unavailable") return uncertain(destination.reason);
  if (destination.kind === "missing") {
    if (source.kind === "file" && analyseUpdate(change.diff, source.text).outcome === "unapplied") return result("unapplied");
    return uncertain("Move destination is missing and the requested source state is not established.");
  }
  const analysed = analyseUpdate(change.diff, destination.text);
  if (analysed.outcome === "present" && source.kind === "file") {
    return { ...analysed, detail: "Requested destination changes are present, but the source still exists.", outcome: "copied" };
  }
  return analysed;
}
