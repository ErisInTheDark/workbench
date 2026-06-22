/*
 * Exports:
 * - LiveMarkdownReconcileAction: minimal DOM/state action for incoming markdown updates. Keywords: workbench, markdown, reconcile, live editor.
 * - reconcileLiveMarkdownUpdate: decide the smallest safe edit when disk/server markdown differs from the live editor. Keywords: workbench, markdown, disk, autosave, merge.
 */

export type LiveMarkdownReconcileAction =
  | { readonly type: "metadataOnly"; readonly baselineContent: string }
  | { readonly type: "keepLocal"; readonly pendingRemoteContent?: string }
  | { readonly type: "appendRemoteTail"; readonly tailMarkdown: string; readonly nextBaselineContent: string }
  | { readonly type: "replaceDocument"; readonly nextContent: string };

interface ReconcileLiveMarkdownUpdateInput {
  readonly baselineContent: string;
  readonly currentContent: string;
  readonly incomingContent: string;
  readonly isDirty: boolean;
  readonly isFocused: boolean;
}

const WORKBENCH_AUTHOR_MARKER_PATTERN = /^<!--\s*(user|agent):\s*-->$/i;

function normalizeContent(content: string) {
  return content.replace(/\r\n/g, "\n").trimEnd();
}

function normalizeForComparison(content: string) {
  return normalizeContent(content).trim();
}

function trimTrailingBlankLines(lines: readonly string[]) {
  let endIndex = lines.length;
  while (endIndex > 0 && !lines[endIndex - 1]?.trim()) {
    endIndex -= 1;
  }

  return lines.slice(0, endIndex);
}

function contentLines(content: string) {
  return trimTrailingBlankLines(normalizeContent(content).split("\n"));
}

function meaningfulLines(content: string) {
  return contentLines(content)
    .map((line) => line.trim())
    .filter((line) => line && !WORKBENCH_AUTHOR_MARKER_PATTERN.test(line));
}

function containsLineSubsequence(container: readonly string[], contained: readonly string[]) {
  if (!contained.length) {
    return false;
  }

  let containedIndex = 0;
  for (const line of container) {
    if (line === contained[containedIndex]) {
      containedIndex += 1;
      if (containedIndex === contained.length) {
        return true;
      }
    }
  }

  return false;
}

function startsWithLines(lines: readonly string[], prefix: readonly string[]) {
  return prefix.length <= lines.length && prefix.every((line, index) => lines[index] === line);
}

function findAppendedTail(baseContent: string, candidateContent: string) {
  const baseLines = contentLines(baseContent);
  const candidateLines = contentLines(candidateContent);
  if (!startsWithLines(candidateLines, baseLines) || candidateLines.length <= baseLines.length) {
    return null;
  }

  const tailLines = candidateLines.slice(baseLines.length);
  return tailLines.some((line) => line.trim()) ? tailLines.join("\n").trimEnd() : null;
}

function isIncrementalLineUpdate(leftContent: string, rightContent: string) {
  const leftLines = meaningfulLines(leftContent);
  const rightLines = meaningfulLines(rightContent);
  if (!leftLines.length || leftLines.length !== rightLines.length) {
    return false;
  }

  return leftLines.every((leftLine, index) => {
    const rightLine = rightLines[index] ?? "";
    return leftLine === rightLine
      || leftLine.startsWith(rightLine)
      || rightLine.startsWith(leftLine);
  });
}

export function reconcileLiveMarkdownUpdate({
  baselineContent,
  currentContent,
  incomingContent,
  isDirty,
  isFocused,
}: ReconcileLiveMarkdownUpdateInput): LiveMarkdownReconcileAction {
  const normalizedBaseline = normalizeForComparison(baselineContent);
  const normalizedCurrent = normalizeForComparison(currentContent);
  const normalizedIncoming = normalizeForComparison(incomingContent);

  if (normalizedIncoming === normalizedCurrent) {
    return { type: "metadataOnly", baselineContent: incomingContent };
  }

  if (normalizedIncoming === normalizedBaseline) {
    return { type: "keepLocal" };
  }

  const currentMeaningful = meaningfulLines(currentContent);
  const incomingMeaningful = meaningfulLines(incomingContent);

  if (containsLineSubsequence(currentMeaningful, incomingMeaningful)) {
    return { type: "keepLocal" };
  }

  if (isIncrementalLineUpdate(currentContent, incomingContent)) {
    return currentContent.length >= incomingContent.length
      ? { type: "keepLocal" }
      : { type: "metadataOnly", baselineContent: incomingContent };
  }

  const incomingTail = findAppendedTail(baselineContent, incomingContent);
  if (incomingTail) {
    return {
      type: "appendRemoteTail",
      tailMarkdown: incomingTail,
      nextBaselineContent: incomingContent,
    };
  }

  const currentTail = findAppendedTail(baselineContent, currentContent);
  if (currentTail) {
    return { type: "keepLocal", pendingRemoteContent: incomingContent };
  }

  if (isDirty || isFocused) {
    return { type: "keepLocal", pendingRemoteContent: incomingContent };
  }

  return { type: "replaceDocument", nextContent: incomingContent };
}
