/*
 * Exports:
 * - CollaborationScratchpadAuthor, CollaborationScratchpadFile: collaboration scratchpad data contracts. Keywords: collaboration, scratchpad, author, file.
 * - COLLABORATION_AUTHOR_MARKER_PATTERN: detects persisted user/agent author comments. Keywords: collaboration, marker, markdown.
 * - createDefaultCollaborationScratchpadContent/formatCollaborationAuthorMarker: create and serialize lightweight author markers. Keywords: collaboration, markdown, serialize.
 * - normalizeCollaborationScratchpadContent/mergeCollaborationScratchpadContent: keep scratchpad content labeled and preserve concurrent edits. Keywords: collaboration, autosave, merge.
 * - renderCollaborationScratchpadMarkdownToHtml/serializeCollaborationScratchpadDomToMarkdown/normalizeCollaborationScratchpadDom: shared editor hooks for non-editable author markers. Keywords: collaboration, editor, render, serialize.
 */

import { markdownToHtml } from "../markdown/markdown-html-render";
import { serializeWorkbenchDomToMarkdown } from "../markdown/markdown-serialization";

export type CollaborationScratchpadAuthor = "user" | "agent";

export interface CollaborationScratchpadFile {
  content: string;
  headContent: string | null;
  mtimeMs: number;
  path: string;
  projectId: string;
  updatedAt: string;
}

export const COLLABORATION_AUTHOR_MARKER_PATTERN = /^<!--\s*(user|agent):\s*-->$/i;

export function formatCollaborationAuthorMarker(author: CollaborationScratchpadAuthor) {
  return `<!-- ${author}: -->`;
}

export function createDefaultCollaborationScratchpadContent() {
  return "";
}

export function hasCollaborationAuthorMarker(content: string) {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => COLLABORATION_AUTHOR_MARKER_PATTERN.test(line.trim()));
}

export function normalizeCollaborationScratchpadContent(
  content: string,
  defaultAuthor: CollaborationScratchpadAuthor = "user",
) {
  const normalizedContent = String(content ?? "").replace(/\r\n/g, "\n");
  if (!normalizedContent.trim()) {
    return createDefaultCollaborationScratchpadContent();
  }
  void defaultAuthor;

  return normalizedContent
    .split("\n")
    .filter((line) => !COLLABORATION_AUTHOR_MARKER_PATTERN.test(line.trim()))
    .join("\n")
    .trimEnd();
}

function normalizeForComparison(content: string) {
  return content.replace(/\r\n/g, "\n").trim();
}

function trimTrailingBlankLines(lines: readonly string[]) {
  let endIndex = lines.length;
  while (endIndex > 0 && !lines[endIndex - 1]?.trim()) {
    endIndex -= 1;
  }

  return lines.slice(0, endIndex);
}

function canonicalizeScratchpadContent(
  content: string,
  defaultAuthor: CollaborationScratchpadAuthor = "user",
) {
  return normalizeCollaborationScratchpadContent(content, defaultAuthor).replace(/\r\n/g, "\n").trimEnd();
}

function getCanonicalScratchpadLines(
  content: string,
  defaultAuthor: CollaborationScratchpadAuthor = "user",
) {
  return trimTrailingBlankLines(canonicalizeScratchpadContent(content, defaultAuthor).split("\n"));
}

function isDefaultScratchpadContent(content: string) {
  return meaningfulScratchpadLines(content).length === 0;
}

function meaningfulScratchpadLines(content: string) {
  return canonicalizeScratchpadContent(content)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !COLLABORATION_AUTHOR_MARKER_PATTERN.test(line));
}

function containsMeaningfulScratchpadContent(container: string, contained: string) {
  const containerLines = meaningfulScratchpadLines(container);
  const containedLines = meaningfulScratchpadLines(contained);
  if (!containedLines.length) {
    return false;
  }

  let containedIndex = 0;
  for (const line of containerLines) {
    if (line === containedLines[containedIndex]) {
      containedIndex += 1;
      if (containedIndex === containedLines.length) {
        return true;
      }
    }
  }

  return false;
}

function isIncrementalTypingUpdate({
  currentContent,
  latestDiskContent,
}: {
  currentContent: string;
  latestDiskContent: string;
}) {
  const currentLines = meaningfulScratchpadLines(currentContent);
  const diskLines = meaningfulScratchpadLines(latestDiskContent);
  if (!currentLines.length || currentLines.length !== diskLines.length) {
    return false;
  }

  return currentLines.every((currentLine, index) => {
    const diskLine = diskLines[index] ?? "";
    return currentLine === diskLine
      || currentLine.startsWith(diskLine)
      || diskLine.startsWith(currentLine);
  });
}

function linesStartWith(lines: readonly string[], prefix: readonly string[]) {
  if (prefix.length > lines.length) {
    return false;
  }

  return prefix.every((line, index) => lines[index] === line);
}

function findAppendedScratchpadTail({
  baseContent,
  candidateContent,
  defaultAuthor,
}: {
  baseContent: string;
  candidateContent: string;
  defaultAuthor: CollaborationScratchpadAuthor;
}) {
  const baseLines = getCanonicalScratchpadLines(baseContent, defaultAuthor);
  const candidateLines = getCanonicalScratchpadLines(candidateContent, defaultAuthor);
  if (!linesStartWith(candidateLines, baseLines) || candidateLines.length <= baseLines.length) {
    return null;
  }

  const tailLines = candidateLines.slice(baseLines.length);
  return tailLines.some((line) => line.trim()) ? tailLines : null;
}

function appendScratchpadTailAfterBase({
  author,
  baseContent,
  content,
  tailLines,
}: {
  author: CollaborationScratchpadAuthor;
  baseContent: string;
  content: string;
  tailLines: readonly string[];
}) {
  const baseLines = getCanonicalScratchpadLines(baseContent, author);
  const contentLines = getCanonicalScratchpadLines(content, author);
  const insertionIndex = linesStartWith(contentLines, baseLines)
    ? baseLines.length
    : contentLines.length;
  const needsAuthorMarker = insertionIndex === contentLines.length
    && !tailLines.some((line) => COLLABORATION_AUTHOR_MARKER_PATTERN.test(line.trim()));
  void needsAuthorMarker;
  const insertedLines = needsAuthorMarker
    ? tailLines
    : tailLines;
  const mergedLines = [
    ...contentLines.slice(0, insertionIndex),
    ...insertedLines,
    ...contentLines.slice(insertionIndex),
  ];

  return `${trimTrailingBlankLines(mergedLines).join("\n")}\n`;
}

function stripScratchpadAuthorMarkers(content: string) {
  return canonicalizeScratchpadContent(content)
    .split("\n")
    .filter((line) => !COLLABORATION_AUTHOR_MARKER_PATTERN.test(line.trim()))
    .join("\n")
    .trim();
}

export function mergeCollaborationScratchpadContent({
  baseContent,
  currentContent,
  latestDiskContent,
}: {
  baseContent?: string | null;
  currentContent: string;
  latestDiskContent: string;
}) {
  const normalizedCurrent = normalizeCollaborationScratchpadContent(currentContent, "user");
  const normalizedDisk = normalizeCollaborationScratchpadContent(latestDiskContent, "agent");
  const normalizedBase = baseContent === null || baseContent === undefined
    ? null
    : normalizeCollaborationScratchpadContent(baseContent, "user");

  if (normalizeForComparison(normalizedDisk) === normalizeForComparison(normalizedCurrent)) {
    return normalizedDisk;
  }

  if (normalizedBase !== null && normalizeForComparison(normalizedDisk) === normalizeForComparison(normalizedBase)) {
    return normalizedCurrent;
  }

  if (normalizedBase !== null && normalizeForComparison(normalizedCurrent) === normalizeForComparison(normalizedBase)) {
    return normalizedDisk;
  }

  if (isDefaultScratchpadContent(normalizedDisk)) {
    return normalizedCurrent;
  }

  if (isDefaultScratchpadContent(normalizedCurrent)) {
    return normalizedDisk;
  }

  if (containsMeaningfulScratchpadContent(normalizedCurrent, normalizedDisk)) {
    return normalizedCurrent;
  }

  if (containsMeaningfulScratchpadContent(normalizedDisk, normalizedCurrent)) {
    return normalizedDisk;
  }

  if (isIncrementalTypingUpdate({
    currentContent: normalizedCurrent,
    latestDiskContent: normalizedDisk,
  })) {
    return stripScratchpadAuthorMarkers(normalizedCurrent).length >= stripScratchpadAuthorMarkers(normalizedDisk).length
      ? normalizedCurrent
      : normalizedDisk;
  }

  if (normalizedBase !== null) {
    const currentTail = findAppendedScratchpadTail({
      baseContent: normalizedBase,
      candidateContent: normalizedCurrent,
      defaultAuthor: "user",
    });
    if (currentTail) {
      return appendScratchpadTailAfterBase({
        author: "user",
        baseContent: normalizedBase,
        content: normalizedDisk,
        tailLines: currentTail,
      });
    }

    const diskTail = findAppendedScratchpadTail({
      baseContent: normalizedBase,
      candidateContent: normalizedDisk,
      defaultAuthor: "agent",
    });
    if (diskTail) {
      return appendScratchpadTailAfterBase({
        author: "agent",
        baseContent: normalizedBase,
        content: normalizedCurrent,
        tailLines: diskTail,
      });
    }
  }

  return normalizedCurrent;
}

function markerElementHtml(author: CollaborationScratchpadAuthor) {
  return `<div contenteditable="false" data-collaboration-author-marker="${author}" data-label="${author}:"></div>`;
}

function isAuthorMarkerElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && (node.dataset.collaborationAuthorMarker === "user" || node.dataset.collaborationAuthorMarker === "agent");
}

export function renderCollaborationScratchpadMarkdownToHtml(content: string) {
  const normalizedContent = normalizeCollaborationScratchpadContent(content, "user");
  return normalizedContent.trim() ? markdownToHtml(normalizedContent) : "<p><br></p>";
}

export function normalizeCollaborationScratchpadDom(root: ParentNode) {
  if (!(root instanceof HTMLElement || root instanceof DocumentFragment)) {
    return;
  }

  const markers = Array.from(root.querySelectorAll("[data-collaboration-author-marker]"));
  for (const marker of markers) {
    if (!(marker instanceof HTMLElement)) {
      continue;
    }

    const author = marker.dataset.collaborationAuthorMarker === "agent" ? "agent" : "user";
    marker.dataset.collaborationAuthorMarker = author;
    marker.dataset.label = `${author}:`;
    marker.contentEditable = "false";
    marker.remove();
  }
}

function serializeFragment(fragment: DocumentFragment, options: { isInlineRunContainer: (element: HTMLElement) => boolean }) {
  return serializeWorkbenchDomToMarkdown(fragment, {
    isInlineRunContainer: options.isInlineRunContainer,
  }).trim();
}

export function serializeCollaborationScratchpadDomToMarkdown(
  root: ParentNode,
  options: { isInlineRunContainer: (element: HTMLElement) => boolean; normalizeMarkup?: (root: ParentNode) => void },
) {
  options.normalizeMarkup?.(root);
  const ownerDocument = root instanceof Node ? root.ownerDocument : globalThis.document;
  const fragment = ownerDocument.createDocumentFragment();
  for (const child of Array.from(root.childNodes)) {
    if (!isAuthorMarkerElement(child)) {
      fragment.append(child.cloneNode(true));
    }
  }

  return normalizeCollaborationScratchpadContent(serializeFragment(fragment, options), "user");
}
