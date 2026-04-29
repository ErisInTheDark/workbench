/*
 * Exports:
 * - UnifiedDiffLine: parsed unified-diff line with type and optional line numbers. Keywords: diff, unified, hunk, line.
 * - UnifiedDiffHunk: parsed unified-diff hunk with header and line rows. Keywords: diff, unified, hunk.
 * - ParsedUnifiedDiff: parsed unified-diff payload with headers, hunks, and change counts. Keywords: diff, unified, counts.
 * - parseUnifiedDiff: parse unified diff text into headers, hunk rows, and addition/deletion counts. Keywords: diff, parse, unified.
 */

export interface UnifiedDiffLine {
  newLineNumber: number | null;
  oldLineNumber: number | null;
  text: string;
  type: "addition" | "context" | "deletion" | "note";
}

export interface UnifiedDiffHunk {
  header: string;
  lines: UnifiedDiffLine[];
}

export interface ParsedUnifiedDiff {
  additions: number;
  deletions: number;
  headers: string[];
  hunks: UnifiedDiffHunk[];
}

export function parseUnifiedDiff(diff: string): ParsedUnifiedDiff {
  const normalizedDiff = String(diff ?? "").replace(/\r\n/g, "\n");
  if (!normalizedDiff.trim()) {
    return {
      additions: 0,
      deletions: 0,
      headers: [],
      hunks: [],
    };
  }

  const lines = normalizedDiff.endsWith("\n")
    ? normalizedDiff.slice(0, -1).split("\n")
    : normalizedDiff.split("\n");
  const parsed: ParsedUnifiedDiff = {
    additions: 0,
    deletions: 0,
    headers: [],
    hunks: [],
  };

  let currentHunk: UnifiedDiffHunk | null = null;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/);
    if (hunkMatch) {
      currentHunk = {
        header: line,
        lines: [],
      };
      parsed.hunks.push(currentHunk);
      oldLineNumber = Number(hunkMatch[1]);
      newLineNumber = Number(hunkMatch[3]);
      continue;
    }

    if (!currentHunk) {
      parsed.headers.push(line);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({
        newLineNumber,
        oldLineNumber: null,
        text: line.slice(1),
        type: "addition",
      });
      parsed.additions += 1;
      newLineNumber += 1;
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.lines.push({
        newLineNumber: null,
        oldLineNumber,
        text: line.slice(1),
        type: "deletion",
      });
      parsed.deletions += 1;
      oldLineNumber += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      currentHunk.lines.push({
        newLineNumber,
        oldLineNumber,
        text: line.slice(1),
        type: "context",
      });
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    currentHunk.lines.push({
      newLineNumber: null,
      oldLineNumber: null,
      text: line,
      type: "note",
    });
  }

  return parsed;
}
