/*
 * Exports:
 * - ParsedListItem: list item node used by the markdown block parser. Keywords: markdown, list, parser.
 * - ParsedBlock: block node union used by markdown parsing and rendering. Keywords: markdown, block, parser.
 * - ParsedInlineNode: inline node union shared by HTML and React markdown render targets. Keywords: markdown, inline, parser, AST.
 * - MarkdownParseProfile: parser behavior profile for editor-stable markdown vs display-only thread markdown. Keywords: markdown, profile, thread, editor.
 * - MarkdownParseOptions: optional project-root and mention context for richer thread parsing. Keywords: markdown, file link, skills, mentions.
 * - parseBlocks: parse markdown into block nodes for rendering and diffing. Keywords: markdown, parser, blocks.
 * - parseInlineMarkdown: parse inline markdown into renderer-neutral nodes. Keywords: markdown, inline, parser.
 * - parseThreadStateChangeMode: detect display-only thread mode change tags. Keywords: thread, mode, state, parser.
 * - formatThreadStateChangeMode: format thread mode identifiers for display. Keywords: thread, mode, label.
 * - stripInlineCodeSpans: remove inline code spans for thread ordered-step detection. Keywords: thread, code, step.
 */

import {
    buildInlineMentionHighlights,
    type InlineMentionHighlightSources,
} from "../thread/inline-mention-highlights";
import {
    isBlockCommentLine,
} from "./comment-markdown";
import {
    normalizeMarkdownHref,
    parseCodexFileLinkHref,
    toProjectRelativeFilePath,
} from "./markdown-links";

export interface ParsedListItem {
  marker: string;
  text: string;
  children: ParsedBlock[];
}

export type ParsedBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "blockquote"; text: string }
  | { type: "plan"; text: string }
  | { type: "ul"; items: ParsedListItem[] }
  | { type: "ol"; items: ParsedListItem[] }
  | { type: "list-break"; count: number }
  | { type: "break"; count: number }
  | { type: "hr" }
  | { type: "code"; language: string; text: string }
  | { type: "comment"; text: string }
  | { type: "paragraph"; text: string };

export type MarkdownParseProfile = "editor" | "thread";

export type ParsedInlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: ParsedInlineNode[] }
  | { type: "em"; children: ParsedInlineNode[] }
  | { type: "delete"; children: ParsedInlineNode[] }
  | { type: "insert"; children: ParsedInlineNode[] }
  | { type: "code"; text: string }
  | { type: "break" }
  | { type: "link"; children: ParsedInlineNode[]; external: boolean; href: string }
  | { type: "inlineComment"; children: ParsedInlineNode[] }
  | { type: "knownSkillMention"; text: string; title: string }
  | {
    type: "projectFileLink";
    columnNumber: number | null;
    href: string;
    lineNumber: number | null;
    relativePath: string;
  };

export interface MarkdownParseOptions {
  inlineMentionSources?: InlineMentionHighlightSources | null;
  profile?: MarkdownParseProfile;
  projectRootPath?: string;
}

function findClosingToken(source: string, token: string, fromIndex: number) {
  for (let index = fromIndex; index < source.length; index += 1) {
    if (source[index - 1] === "\\") {
      continue;
    }

    if (source.startsWith(token, index)) {
      return index;
    }
  }

  return -1;
}

function getBacktickRunLength(source: string, fromIndex: number) {
  let index = fromIndex;
  while (source[index] === "`") {
    index += 1;
  }

  return index - fromIndex;
}

function findClosingCodeSpanFence(source: string, fenceLength: number, fromIndex: number) {
  for (let index = fromIndex; index < source.length; index += 1) {
    if (source[index] !== "`") {
      continue;
    }

    if (source[index - 1] === "\\") {
      continue;
    }

    const runLength = getBacktickRunLength(source, index);
    if (runLength === fenceLength) {
      return index;
    }

    index += runLength - 1;
  }

  return -1;
}

function trimCodeSpanPadding(content: string) {
  if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ")) {
    return content.slice(1, -1);
  }

  return content;
}

export function stripInlineCodeSpans(markdown: string) {
  let text = "";
  let index = 0;

  while (index < markdown.length) {
    if (markdown[index] === "`") {
      const fenceLength = getBacktickRunLength(markdown, index);
      const closeIndex = findClosingCodeSpanFence(markdown, fenceLength, index + fenceLength);
      if (closeIndex !== -1) {
        index = closeIndex + fenceLength;
        continue;
      }
    }

    text += markdown[index];
    index += 1;
  }

  return text;
}

export function parseThreadStateChangeMode(markdown: string, options: MarkdownParseOptions) {
  if ((options.profile ?? "editor") !== "thread") {
    return null;
  }

  const match = markdown.trim().match(/^<set-state\s+mode=(["'])([A-Za-z][A-Za-z0-9_-]*)\1\s*\/>$/);
  return match?.[2].toLowerCase() ?? null;
}

export function formatThreadStateChangeMode(mode: string) {
  return mode
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sanitizeMarkdownHref(value: string) {
  const trimmed = normalizeMarkdownHref(value);
  if (!trimmed) {
    return null;
  }

  if (
    /^(https?:|mailto:|app:|plugin:|codex:|ws:|wss:)/i.test(trimmed)
    || /^(\/|#|\.{1,2}\/)/.test(trimmed)
    || /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return trimmed;
  }

  return null;
}

function isExternalMarkdownHref(value: string) {
  return /^(https?:|mailto:|ws:|wss:)/i.test(value);
}

function isWordCharacter(value: string | undefined) {
  return !!value && /[A-Za-z0-9_]/.test(value);
}

function isWhitespace(value: string | undefined) {
  return !value || /\s/.test(value);
}

function isGlobLikeAsterisk(source: string, index: number) {
  const previous = source[index - 1];
  const next = source[index + 1];

  return next === "."
    || next === "/"
    || previous === "/"
    || previous === "."
    || (previous === "*" && next === "/")
    || (previous === "/" && next === "*");
}

function canOpenThreadSingleEmphasis(source: string, index: number, marker: string) {
  const previous = source[index - 1];
  const next = source[index + 1];
  if (isWhitespace(next)) {
    return false;
  }

  if (marker === "_" && isWordCharacter(previous) && isWordCharacter(next)) {
    return false;
  }

  if (marker === "*" && isGlobLikeAsterisk(source, index)) {
    return false;
  }

  return true;
}

function canCloseThreadSingleEmphasis(source: string, index: number, marker: string) {
  const previous = source[index - 1];
  const next = source[index + 1];
  if (isWhitespace(previous)) {
    return false;
  }

  if (marker === "_" && isWordCharacter(previous) && isWordCharacter(next)) {
    return false;
  }

  if (marker === "*" && isGlobLikeAsterisk(source, index)) {
    return false;
  }

  return true;
}

function findClosingSingleEmphasisToken(source: string, token: string, fromIndex: number, options: MarkdownParseOptions) {
  const profile = options.profile ?? "editor";
  if (profile !== "thread") {
    return findClosingToken(source, token, fromIndex);
  }

  for (let index = fromIndex; index < source.length; index += 1) {
    if (source[index - 1] === "\\") {
      continue;
    }

    if (source.startsWith(token, index) && canCloseThreadSingleEmphasis(source, index, token)) {
      return index;
    }
  }

  return -1;
}

function getInlineMentionHighlights(markdown: string, options: MarkdownParseOptions) {
  const sources = options.inlineMentionSources;
  if (!sources || (options.profile ?? "editor") !== "thread") {
    return [];
  }

  return buildInlineMentionHighlights(markdown, sources);
}

function pushTextNode(nodes: ParsedInlineNode[], text: string) {
  if (!text) {
    return;
  }

  const previous = nodes[nodes.length - 1];
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }

  nodes.push({ type: "text", text });
}

function createProjectFileLinkNode(url: string, relativePath: string, {
  columnNumber = null,
  lineNumber = null,
}: {
  columnNumber?: number | null;
  lineNumber?: number | null;
} = {}): Extract<ParsedInlineNode, { type: "projectFileLink" }> {
  return {
    columnNumber,
    href: url,
    lineNumber,
    relativePath,
    type: "projectFileLink",
  };
}

export function parseInlineMarkdown(markdown: string, options: MarkdownParseOptions = {}) {
  const nodes: ParsedInlineNode[] = [];
  let index = 0;
  const inlineMentionHighlights = getInlineMentionHighlights(markdown, options);
  let inlineMentionIndex = 0;

  while (index < markdown.length) {
    if (markdown[index] === "\\") {
      pushTextNode(nodes, markdown.slice(index + 1, index + 2));
      index += 2;
      continue;
    }

    if (markdown.startsWith("<del>", index)) {
      const closeIndex = markdown.indexOf("</del>", index + 5);
      if (closeIndex !== -1) {
        nodes.push({
          children: parseInlineMarkdown(markdown.slice(index + 5, closeIndex), options),
          type: "delete",
        });
        index = closeIndex + 6;
        continue;
      }
    }

    if (markdown.startsWith("<ins>", index)) {
      const closeIndex = markdown.indexOf("</ins>", index + 5);
      if (closeIndex !== -1) {
        nodes.push({
          children: parseInlineMarkdown(markdown.slice(index + 5, closeIndex), options),
          type: "insert",
        });
        index = closeIndex + 6;
        continue;
      }
    }

    if (markdown.startsWith("<!--", index)) {
      const closeIndex = markdown.indexOf("-->", index + 4);
      if (closeIndex !== -1) {
        const commentBody = markdown.slice(index + 4, closeIndex).trim();
        nodes.push({
          children: parseInlineMarkdown(commentBody, options),
          type: "inlineComment",
        });
        index = closeIndex + 3;
        continue;
      }
    }

    if (markdown.startsWith("**", index) || markdown.startsWith("__", index)) {
      const marker = markdown.slice(index, index + 2);
      const closeIndex = findClosingToken(markdown, marker, index + 2);
      if (closeIndex !== -1) {
        nodes.push({
          children: parseInlineMarkdown(markdown.slice(index + 2, closeIndex), options),
          type: "strong",
        });
        index = closeIndex + 2;
        continue;
      }
    }

    if (markdown.startsWith("~~", index)) {
      const closeIndex = findClosingToken(markdown, "~~", index + 2);
      if (closeIndex !== -1) {
        nodes.push({
          children: parseInlineMarkdown(markdown.slice(index + 2, closeIndex), options),
          type: "delete",
        });
        index = closeIndex + 2;
        continue;
      }
    }

    if (markdown[index] === "*" || markdown[index] === "_") {
      const marker = markdown[index];
      if ((options.profile ?? "editor") === "thread" && !canOpenThreadSingleEmphasis(markdown, index, marker)) {
        pushTextNode(nodes, markdown[index]);
        index += 1;
        continue;
      }

      const closeIndex = findClosingSingleEmphasisToken(markdown, marker, index + 1, options);
      if (closeIndex !== -1) {
        nodes.push({
          children: parseInlineMarkdown(markdown.slice(index + 1, closeIndex), options),
          type: "em",
        });
        index = closeIndex + 1;
        continue;
      }
    }

    if (markdown[index] === "`") {
      const fenceLength = getBacktickRunLength(markdown, index);
      const closeIndex = findClosingCodeSpanFence(markdown, fenceLength, index + fenceLength);
      if (closeIndex !== -1) {
        const content = markdown.slice(index + fenceLength, closeIndex);
        nodes.push({ text: trimCodeSpanPadding(content), type: "code" });
        index = closeIndex + fenceLength;
        continue;
      }
    }

    while (
      inlineMentionIndex < inlineMentionHighlights.length
      && inlineMentionHighlights[inlineMentionIndex].end <= index
    ) {
      inlineMentionIndex += 1;
    }
    const inlineMention = inlineMentionHighlights[inlineMentionIndex]?.start === index
      ? inlineMentionHighlights[inlineMentionIndex]
      : null;
    if (inlineMention) {
      if (inlineMention.kind === "skill") {
        nodes.push({
          text: inlineMention.text,
          title: inlineMention.title,
          type: "knownSkillMention",
        });
      } else {
        nodes.push(createProjectFileLinkNode(`#${inlineMention.path}`, inlineMention.path, {
          columnNumber: inlineMention.columnNumber ?? null,
          lineNumber: inlineMention.lineNumber ?? null,
        }));
      }
      index = inlineMention.end;
      continue;
    }

    if (markdown[index] === "[") {
      const labelEnd = findClosingToken(markdown, "]", index + 1);
      if (labelEnd !== -1 && markdown[labelEnd + 1] === "(") {
        const urlEnd = findClosingToken(markdown, ")", labelEnd + 2);
        if (urlEnd !== -1) {
          const label = markdown.slice(index + 1, labelEnd);
          const url = sanitizeMarkdownHref(markdown.slice(labelEnd + 2, urlEnd));
          if (url) {
            const parsedFileLink = parseCodexFileLinkHref(url);
            const relativePath = parsedFileLink
              ? toProjectRelativeFilePath(parsedFileLink.absolutePath, options.projectRootPath ?? "")
              : null;

            if (relativePath) {
              nodes.push(createProjectFileLinkNode(url, relativePath, {
                columnNumber: parsedFileLink?.columnNumber ?? null,
                lineNumber: parsedFileLink?.lineNumber ?? null,
              }));
              index = urlEnd + 1;
              continue;
            }

            nodes.push({
              children: parseInlineMarkdown(label, options),
              external: isExternalMarkdownHref(url),
              href: url,
              type: "link",
            });
            index = urlEnd + 1;
            continue;
          }
        }
      }
    }

    if (markdown[index] === "\n") {
      nodes.push({ type: "break" });
      index += 1;
      continue;
    }

    pushTextNode(nodes, markdown[index]);
    index += 1;
  }

  return nodes;
}

function parseListLine(line: string) {
  const expandedLine = line.replaceAll("\t", "  ");
  const match = expandedLine.match(/^(\s*)([-*+]|\d+[.)])(?:\s+(.*))?$/);
  if (!match) {
    return null;
  }

  return {
    indent: match[1].length,
    marker: match[2],
    text: match[3] ?? "",
    type: (/^\d+[.)]$/.test(match[2]) ? "ol" : "ul") as "ol" | "ul",
  };
}

function parseSpecificListBlock(lines: string[], startIndex: number, indent: number, type: "ul" | "ol") {
  const items: ParsedListItem[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = parseListLine(lines[index]);
    if (!line || line.indent !== indent || line.type !== type) {
      break;
    }

    const item: ParsedListItem = {
      marker: line.marker,
      text: line.text,
      children: [],
    };
    index += 1;

    while (index < lines.length) {
      const nestedLine = parseListLine(lines[index]);
      if (!nestedLine || nestedLine.indent <= indent) {
        break;
      }

      const nestedBlock = parseSpecificListBlock(lines, index, nestedLine.indent, nestedLine.type);
      item.children.push(nestedBlock.block);
      index = nestedBlock.nextIndex;
    }

    items.push(item);
  }

  return {
    block: { type, items } satisfies Extract<ParsedBlock, { type: "ul" | "ol" }>,
    nextIndex: index,
  };
}

function parseListBlock(lines: string[], startIndex: number) {
  const firstLine = parseListLine(lines[startIndex]);
  if (!firstLine) {
    return null;
  }

  return parseSpecificListBlock(lines, startIndex, firstLine.indent, firstLine.type);
}

function getLastNonBreakBlock(blocks: ParsedBlock[]) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].type !== "break" && blocks[index].type !== "list-break") {
      return blocks[index];
    }
  }

  return null;
}

function maybePushCommentBreak(blocks: ParsedBlock[], blankLineCount: number, nextBlockType: ParsedBlock["type"]) {
  if (!blankLineCount) {
    return;
  }

  const previousBlock = getLastNonBreakBlock(blocks);
  if (nextBlockType === "comment" || previousBlock?.type === "comment") {
    blocks.push({ type: "break", count: blankLineCount });
  }
}

function maybePushStandardBreak(
  blocks: ParsedBlock[],
  blankLineCount: number,
  nextBlockType: ParsedBlock["type"],
) {
  if (blankLineCount <= 1) {
    return;
  }

  const previousBlock = getLastNonBreakBlock(blocks);
  if (!previousBlock || previousBlock.type === "comment" || nextBlockType === "comment") {
    return;
  }

  const previousIsList = previousBlock.type === "ul" || previousBlock.type === "ol";
  const nextIsList = nextBlockType === "ul" || nextBlockType === "ol";
  if (previousIsList && nextIsList) {
    return;
  }

  blocks.push({ type: "break", count: blankLineCount - 1 });
}

function isThreadPlanOpenLine(line: string, options: MarkdownParseOptions) {
  return (options.profile ?? "editor") === "thread"
    && /^<plan>\s*$/i.test(line.trim());
}

function isThreadPlanCloseLine(line: string) {
  return /^<\/plan>\s*$/i.test(line.trim());
}

export function parseBlocks(markdown: string, options: MarkdownParseOptions = {}): ParsedBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ParsedBlock[] = [];
  let blankLineCount = 0;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];

    if (!line.trim()) {
      blankLineCount += 1;
      index += 1;
      continue;
    }

    if (isThreadPlanOpenLine(line, options)) {
      maybePushCommentBreak(blocks, blankLineCount, "plan");
      maybePushStandardBreak(blocks, blankLineCount, "plan");
      blankLineCount = 0;
      const planLines: string[] = [];
      index += 1;

      while (index < lines.length && !isThreadPlanCloseLine(lines[index])) {
        planLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({ type: "plan", text: planLines.join("\n").trim() });
      continue;
    }

    if (isBlockCommentLine(line)) {
      maybePushCommentBreak(blocks, blankLineCount, "comment");
      blankLineCount = 0;
      blocks.push({ type: "comment", text: line });
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^```(.*)$/);
    if (fenceMatch) {
      maybePushCommentBreak(blocks, blankLineCount, "code");
      maybePushStandardBreak(blocks, blankLineCount, "code");
      blankLineCount = 0;
      const language = fenceMatch[1].trim();
      const codeLines = [];
      index += 1;

      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({ type: "code", language, text: codeLines.join("\n") });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      maybePushCommentBreak(blocks, blankLineCount, "heading");
      maybePushStandardBreak(blocks, blankLineCount, "heading");
      blankLineCount = 0;
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      index += 1;
      continue;
    }

    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      maybePushCommentBreak(blocks, blankLineCount, "hr");
      maybePushStandardBreak(blocks, blankLineCount, "hr");
      blankLineCount = 0;
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      maybePushCommentBreak(blocks, blankLineCount, "blockquote");
      maybePushStandardBreak(blocks, blankLineCount, "blockquote");
      blankLineCount = 0;
      const quoteLines = [];

      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }

      blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    const listBlock = parseListBlock(lines, index);
    if (listBlock) {
      const previousBlock = getLastNonBreakBlock(blocks);
      const previousIsList = previousBlock?.type === "ul" || previousBlock?.type === "ol";
      if (blankLineCount > 0 && previousIsList) {
        blocks.push({ type: "list-break", count: blankLineCount });
      } else {
        maybePushCommentBreak(blocks, blankLineCount, listBlock.block.type);
        maybePushStandardBreak(blocks, blankLineCount, listBlock.block.type);
      }
      blankLineCount = 0;
      blocks.push(listBlock.block);
      index = listBlock.nextIndex;
      continue;
    }

    const paragraphLines = [];
    maybePushCommentBreak(blocks, blankLineCount, "paragraph");
    maybePushStandardBreak(blocks, blankLineCount, "paragraph");
    blankLineCount = 0;
    while (
      index < lines.length
      && lines[index].trim()
      && !isBlockCommentLine(lines[index])
      && !/^```/.test(lines[index])
      && !/^(#{1,6})\s+/.test(lines[index])
      && !/^>\s?/.test(lines[index])
      && !/^[-*+]\s+/.test(lines[index])
      && !/^\d+[.)]\s+/.test(lines[index])
      && !/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join("\n") });
  }

  if (blankLineCount > 0 && getLastNonBreakBlock(blocks)?.type === "comment") {
    blocks.push({ type: "break", count: blankLineCount });
  }

  return blocks;
}

