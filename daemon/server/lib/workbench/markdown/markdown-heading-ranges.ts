/*
 * Exports:
 * - MarkdownHeadingRange/listMarkdownHeadingRanges: locate hierarchy-aware ATX heading source ranges outside fenced code and HTML comments.
 * - listMarkdownHeadingRangeLines: format heading ranges for the toc command.
 */
export interface MarkdownHeadingRange {
  readonly endLine: number;
  readonly endOffset: number;
  readonly level: number;
  readonly source: string;
  readonly startLine: number;
  readonly startOffset: number;
}

interface MarkdownHeading {
  level: number;
  line: number;
  offset: number;
  source: string;
}

interface MarkdownFence {
  length: number;
  marker: "`" | "~";
}

function backtickRunLength(source: string, fromIndex: number) {
  let index = fromIndex;
  while (source[index] === "`") index += 1;
  return index - fromIndex;
}

function findClosingCodeSpan(source: string, fenceLength: number, fromIndex: number) {
  for (let index = fromIndex; index < source.length; index += 1) {
    if (source[index] !== "`" || source[index - 1] === "\\") continue;
    const runLength = backtickRunLength(source, index);
    if (runLength === fenceLength) return index + runLength;
    index += runLength - 1;
  }
  return -1;
}

function updateHtmlCommentState(line: string, startsInsideComment: boolean) {
  let inComment = startsInsideComment;
  let index = 0;

  while (index < line.length) {
    if (inComment) {
      const closeIndex = line.indexOf("-->", index);
      if (closeIndex === -1) return true;
      inComment = false;
      index = closeIndex + 3;
      continue;
    }

    const openIndex = line.indexOf("<!--", index);
    const codeSpanIndex = line.indexOf("`", index);
    if (codeSpanIndex !== -1 && (openIndex === -1 || codeSpanIndex < openIndex)) {
      if (line[codeSpanIndex - 1] === "\\") {
        index = codeSpanIndex + 1;
        continue;
      }
      const fenceLength = backtickRunLength(line, codeSpanIndex);
      const afterCodeSpan = findClosingCodeSpan(line, fenceLength, codeSpanIndex + fenceLength);
      if (afterCodeSpan !== -1) {
        index = afterCodeSpan;
        continue;
      }
      index = codeSpanIndex + fenceLength;
      continue;
    }

    if (openIndex === -1) return false;
    if (line[openIndex - 1] === "\\") {
      index = openIndex + 4;
      continue;
    }
    inComment = true;
    index = openIndex + 4;
  }

  return inComment;
}

function parseFenceOpen(line: string): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,}).*$/u.exec(line);
  if (!match) return null;
  return {
    length: match[1].length,
    marker: match[1][0] as MarkdownFence["marker"],
  };
}

function isFenceClose(line: string, fence: MarkdownFence) {
  const match = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
  return !!match && match[1][0] === fence.marker && match[1].length >= fence.length;
}

function parseHeading(line: string, lineNumber: number, offset: number): MarkdownHeading | null {
  const match = /^( {0,3})(#+)(?:[ \t]+.*)?$/u.exec(line);
  if (!match) return null;
  return {
    level: match[2].length,
    line: lineNumber,
    offset,
    source: line.slice(match[1].length).trimEnd(),
  };
}

export function listMarkdownHeadingRanges(markdown: string): MarkdownHeadingRange[] {
  const normalizedMarkdown = markdown.replace(/\r\n?/gu, "\n");
  const lines = normalizedMarkdown.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const headings: MarkdownHeading[] = [];
  let fence: MarkdownFence | null = null;
  let inHtmlComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }
    if (inHtmlComment) {
      inHtmlComment = updateHtmlCommentState(line, true);
      continue;
    }

    fence = parseFenceOpen(line);
    if (fence) continue;

    const heading = parseHeading(line, index + 1, lineOffsets[index]);
    if (heading) headings.push(heading);
    inHtmlComment = updateHtmlCommentState(line, false);
  }

  return headings.map((heading, index) => {
    let endLine = lines.length;
    let endOffset = normalizedMarkdown.length;
    for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
      if (headings[nextIndex].level <= heading.level) {
        endLine = headings[nextIndex].line - 1;
        endOffset = headings[nextIndex].offset;
        break;
      }
    }
    return {
      endLine,
      endOffset,
      level: heading.level,
      source: heading.source,
      startLine: heading.line,
      startOffset: heading.offset,
    };
  });
}

export function listMarkdownHeadingRangeLines(markdown: string) {
  return listMarkdownHeadingRanges(markdown)
    .map(({ endLine, source, startLine }) => `${startLine}-${endLine} ${source}`);
}
