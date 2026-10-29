/*
 * Exports:
 * - ParsedCodeFenceOpenLine: a markdown code fence's indentation, length and language.
 * - parseCodeFenceOpenLine/isCodeFenceCloseLine: recognise matching markdown fence lines.
 * - parseListLine: recognise markdown list markers and their content indentation.
 * - createCodeFenceTracker: track fenced lines, including list-item fences.
 */
export interface ParsedCodeFenceOpenLine {
  fenceLength: number;
  indent: string;
  language: string;
}

export function parseCodeFenceOpenLine(line: string): ParsedCodeFenceOpenLine | null {
  const match = line.match(/^( {0,3})(`{3,})(.*)$/);
  if (!match || match[3]!.includes("`")) return null;
  return { fenceLength: match[2]!.length, indent: match[1]!, language: match[3]!.trim() };
}

export function parseListLine(line: string) {
  const match = line.replaceAll("\t", "  ").match(/^(\s*)([-*+]|\d+[.)])(?:(\s+)(.*))?$/);
  if (!match) return null;
  const markerIndent = match[1]!.length;
  const marker = match[2]!;
  const markerSpacing = match[3] ?? " ";
  return {
    contentIndent: markerIndent + marker.length + markerSpacing.length,
    indent: markerIndent,
    marker,
    text: match[4] ?? "",
    type: (/^\d+[.)]$/.test(marker) ? "ol" : "ul") as "ol" | "ul",
  };
}

export function isCodeFenceCloseLine(line: string, opener: ParsedCodeFenceOpenLine) {
  const match = line.match(/^( *)(`{3,})[ \t]*$/);
  return !!match && match[1] === opener.indent && match[2]!.length >= opener.fenceLength;
}

export function createCodeFenceTracker() {
  let opener: ParsedCodeFenceOpenLine | null = null;
  const feed = (line: string) => {
    if (opener) {
      if (isCodeFenceCloseLine(line, opener)) opener = null;
      return true;
    }
    const listLine = parseListLine(line);
    const listOpener = listLine && parseCodeFenceOpenLine(listLine.text);
    opener = parseCodeFenceOpenLine(line)
      ?? (listOpener ? { ...listOpener, indent: " ".repeat(listLine!.contentIndent) } : null);
    return opener !== null;
  };
  return Object.assign(feed, { isOpen: () => opener !== null });
}
