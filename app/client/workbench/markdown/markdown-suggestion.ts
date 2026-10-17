/*
 * Exports:
 * - MarkdownSuggestion: a proposed replacement of whole blocks; an empty side means pure insertion or deletion.
 * - formatSuggestion: write a suggestion as a `<del>` block directly followed by an `<ins>` block.
 * - readSuggestionBlock: read a suggestion starting at a line index, or null when the lines do not hold one.
 */

export interface MarkdownSuggestion {
  old: string;
  new: string;
}

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;

function trimBlankEdgeLines(lines: readonly string[]) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]!.trim()) start += 1;
  while (end > start && !lines[end - 1]!.trim()) end -= 1;
  return lines.slice(start, end).join("\n");
}

/** Lines up to the closing tag, which never counts inside a fenced code block. */
function collectTagBody(lines: readonly string[], startIndex: number, tag: "del" | "ins") {
  let fence: string | null = null;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceMatch = line.match(FENCE_PATTERN);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      continue;
    }
    if (line.trim() === `</${tag}>`) {
      return { body: trimBlankEdgeLines(lines.slice(startIndex, index)), nextIndex: index + 1 };
    }
  }
  return null;
}

export function readSuggestionBlock(lines: readonly string[], index: number) {
  const opener = lines[index]?.trim();
  if (opener !== "<del>" && opener !== "<ins>") {
    return null;
  }

  const first = collectTagBody(lines, index + 1, opener === "<del>" ? "del" : "ins");
  if (!first) {
    return null;
  }

  if (opener === "<ins>") {
    return { suggestion: { old: "", new: first.body } satisfies MarkdownSuggestion, nextIndex: first.nextIndex };
  }

  const insertion = lines[first.nextIndex]?.trim() === "<ins>" ? collectTagBody(lines, first.nextIndex + 1, "ins") : null;
  return {
    suggestion: { old: first.body, new: insertion?.body ?? "" } satisfies MarkdownSuggestion,
    nextIndex: insertion?.nextIndex ?? first.nextIndex,
  };
}

export function formatSuggestion(suggestion: MarkdownSuggestion) {
  const parts: string[] = [];
  if (suggestion.old) parts.push(`<del>\n\n${suggestion.old}\n\n</del>`);
  if (suggestion.new) parts.push(`<ins>\n\n${suggestion.new}\n\n</ins>`);
  return parts.join("\n");
}
