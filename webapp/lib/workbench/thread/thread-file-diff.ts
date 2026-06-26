/*
 * Exports:
 * - UnifiedDiffLine: parsed unified-diff line with type and optional line numbers. Keywords: diff, unified, hunk, line.
 * - UnifiedDiffHunk: parsed unified-diff hunk with header and line rows. Keywords: diff, unified, hunk.
 * - ParsedUnifiedDiff: parsed unified-diff payload with headers, hunks, and change counts. Keywords: diff, unified, counts.
 * - ParsedUnifiedDiffFileChange: parsed per-file change from a multi-file unified diff. Keywords: diff, unified, file change.
 * - parseUnifiedDiff: parse unified diff text into headers, hunk rows, and addition/deletion counts. Keywords: diff, parse, unified.
 * - parseUnifiedDiffFileChanges: split multi-file unified diff text into file-change entries. Keywords: diff, parse, files.
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

export interface ParsedUnifiedDiffFileChange {
  diff: string;
  kind:
    | { type: "add" }
    | { type: "delete" }
    | { movePath: string | null; type: "update" };
  path: string;
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

export function parseUnifiedDiffFileChanges(diff: string): ParsedUnifiedDiffFileChange[] {
  const normalizedDiff = String(diff ?? "").replace(/\r\n/g, "\n");
  if (!normalizedDiff.trim()) {
    return [];
  }

  return splitUnifiedDiffFiles(normalizedDiff)
    .map(parseUnifiedDiffFileChange)
    .filter((change): change is ParsedUnifiedDiffFileChange => change !== null);
}

function splitUnifiedDiffFiles(diff: string) {
  const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
  const files: string[] = [];
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && currentLines.length) {
      files.push(`${currentLines.join("\n")}\n`);
      currentLines = [];
    }

    currentLines.push(line);
  }

  if (currentLines.length) {
    files.push(`${currentLines.join("\n")}${diff.endsWith("\n") ? "\n" : ""}`);
  }

  return files;
}

function parseUnifiedDiffFileChange(diff: string): ParsedUnifiedDiffFileChange | null {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const oldPath = readDiffHeaderPath(lines, "--- ", "a/");
  const newPath = readDiffHeaderPath(lines, "+++ ", "b/");
  const renameFrom = readDiffMetadataValue(lines, "rename from ");
  const renameTo = readDiffMetadataValue(lines, "rename to ");
  const isAdd = lines.some((line) => line.startsWith("new file mode ")) || oldPath === null && newPath !== null;
  const isDelete = lines.some((line) => line.startsWith("deleted file mode ")) || oldPath !== null && newPath === null;
  const path = renameTo ?? newPath ?? oldPath ?? readDiffGitPath(lines);

  if (!path) {
    return null;
  }

  if (isAdd) {
    return {
      diff,
      kind: { type: "add" },
      path,
    };
  }

  if (isDelete) {
    return {
      diff,
      kind: { type: "delete" },
      path,
    };
  }

  return {
    diff,
    kind: {
      movePath: renameFrom,
      type: "update",
    },
    path,
  };
}

function readDiffHeaderPath(lines: string[], prefix: "--- " | "+++ ", stripPrefix: "a/" | "b/") {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    return null;
  }

  const path = normalizeDiffPath(line.slice(prefix.length).trim());
  if (!path || path === "/dev/null") {
    return null;
  }

  return path.startsWith(stripPrefix) ? path.slice(stripPrefix.length) : path;
}

function readDiffMetadataValue(lines: string[], prefix: string) {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line ? normalizeDiffPath(line.slice(prefix.length).trim()) : null;
}

function readDiffGitPath(lines: string[]) {
  const line = lines.find((candidate) => candidate.startsWith("diff --git "));
  if (!line) {
    return null;
  }

  const match = line.match(/^diff --git\s+(.+?)\s+(.+)$/);
  const path = normalizeDiffPath(match?.[2] ?? "");
  return path?.startsWith("b/") ? path.slice(2) : path;
}

function normalizeDiffPath(path: string) {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return null;
  }

  return trimmedPath
    .replace(/^"|"$/g, "")
    .replace(/\\(["\\])/g, "$1");
}
