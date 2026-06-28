/*
 * Exports:
 * - CollaborationScratchpadAuthor, CollaborationScratchpadFile: collaboration scratchpad data contracts. Keywords: collaboration, scratchpad, author, file.
 * - CollaborationScratchpadImage/CollaborationScratchpadRenderOptions: scratchpad image block data and render context. Keywords: collaboration, scratchpad, image, asset.
 * - COLLABORATION_AUTHOR_MARKER_PATTERN: detects persisted user/agent author comments. Keywords: collaboration, marker, markdown.
 * - createDefaultCollaborationScratchpadContent/formatCollaborationAuthorMarker: create and serialize lightweight author markers. Keywords: collaboration, markdown, serialize.
 * - extractCollaborationScratchpadImages/formatCollaborationScratchpadImageMarkdown: parse and write scratchpad image markdown blocks. Keywords: collaboration, scratchpad, image, markdown.
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

export interface CollaborationScratchpadImage {
  alt: string;
  href: string;
  id: string;
}

export interface CollaborationScratchpadRenderOptions {
  assetApiPath?: string;
  projectId?: string;
  scratchpadPath?: string;
}

export const COLLABORATION_AUTHOR_MARKER_PATTERN = /^<!--\s*(user|agent):\s*-->$/i;
const COLLABORATION_SCRATCHPAD_IMAGE_MARKDOWN_PATTERN = /^!\[([^\]\n]*)\]\(([^)\s]+)\)\s*$/u;
const COLLABORATION_SCRATCHPAD_IMAGE_ASSET_HREF_PATTERN = /^scratchpad-image-[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/u;
const COLLABORATION_SCRATCHPAD_IMAGE_DEFAULT_ALT = "Scratchpad image";

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

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isExternalHref(href: string) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(href) || href.startsWith("//");
}

function isLocalScratchpadImageHref(href: string) {
  const normalizedHref = href.trim().replace(/\\/g, "/");
  return Boolean(normalizedHref)
    && !isExternalHref(normalizedHref)
    && !normalizedHref.startsWith("/")
    && !normalizedHref.includes("/")
    && !normalizedHref.split("/").includes("..")
    && COLLABORATION_SCRATCHPAD_IMAGE_ASSET_HREF_PATTERN.test(normalizedHref);
}

function createScratchpadImageId(href: string, index: number) {
  let hash = 5381;
  for (let characterIndex = 0; characterIndex < href.length; characterIndex += 1) {
    hash = ((hash << 5) + hash) ^ href.charCodeAt(characterIndex);
  }

  return `scratchpad-image-${index + 1}-${(hash >>> 0).toString(36)}`;
}

function parseCollaborationScratchpadImageLine(line: string) {
  const match = COLLABORATION_SCRATCHPAD_IMAGE_MARKDOWN_PATTERN.exec(line.trim());
  if (!match) {
    return null;
  }

  const href = match[2]?.trim() ?? "";
  if (!isLocalScratchpadImageHref(href)) {
    return null;
  }

  return {
    alt: match[1]?.trim() || COLLABORATION_SCRATCHPAD_IMAGE_DEFAULT_ALT,
    href,
  };
}

export function formatCollaborationScratchpadImageMarkdown({
  alt = COLLABORATION_SCRATCHPAD_IMAGE_DEFAULT_ALT,
  href,
}: {
  alt?: string;
  href: string;
}) {
  const normalizedAlt = alt.replace(/[\]\r\n]/g, " ").replace(/\s+/g, " ").trim() || COLLABORATION_SCRATCHPAD_IMAGE_DEFAULT_ALT;
  return `![${normalizedAlt}](${href})`;
}

export function extractCollaborationScratchpadImages(content: string): CollaborationScratchpadImage[] {
  const images: CollaborationScratchpadImage[] = [];
  for (const line of normalizeCollaborationScratchpadContent(content, "user").split("\n")) {
    const image = parseCollaborationScratchpadImageLine(line);
    if (!image) {
      continue;
    }

    images.push({
      ...image,
      id: createScratchpadImageId(image.href, images.length),
    });
  }

  return images;
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

function getScratchpadImageSrc(href: string, options: CollaborationScratchpadRenderOptions) {
  if (!options.assetApiPath || !options.projectId || !options.scratchpadPath) {
    return href;
  }

  return `${options.assetApiPath}?projectId=${encodeURIComponent(options.projectId)}&path=${encodeURIComponent(options.scratchpadPath)}&href=${encodeURIComponent(href)}`;
}

function imageElementHtml(image: Omit<CollaborationScratchpadImage, "id">, options: CollaborationScratchpadRenderOptions = {}) {
  const src = getScratchpadImageSrc(image.href, options);
  return `<figure contenteditable="false" data-collaboration-scratchpad-image="true" data-href="${escapeHtml(image.href)}" data-alt="${escapeHtml(image.alt)}">`
    + `<img src="${escapeHtml(src)}" alt="${escapeHtml(image.alt)}" draggable="false">`
    + "</figure>";
}

export function renderCollaborationScratchpadMarkdownToHtml(content: string, options: CollaborationScratchpadRenderOptions = {}) {
  const normalizedContent = normalizeCollaborationScratchpadContent(content, "user");
  if (!normalizedContent.trim()) {
    return "<p><br></p>";
  }

  const htmlChunks: string[] = [];
  let markdownLines: string[] = [];
  const flushMarkdown = () => {
    const markdown = markdownLines.join("\n").trimEnd();
    if (markdown.trim()) {
      htmlChunks.push(markdownToHtml(markdown));
    }
    markdownLines = [];
  };

  for (const line of normalizedContent.split("\n")) {
    const image = parseCollaborationScratchpadImageLine(line);
    if (!image) {
      markdownLines.push(line);
      continue;
    }

    flushMarkdown();
    htmlChunks.push(imageElementHtml(image, options));
  }

  flushMarkdown();
  return htmlChunks.join("") || "<p><br></p>";
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

  const images = Array.from(root.querySelectorAll("[data-collaboration-scratchpad-image]"));
  for (const image of images) {
    if (!(image instanceof HTMLElement)) {
      continue;
    }

    image.contentEditable = "false";
  }
}

function serializeFragment(fragment: DocumentFragment, options: { isInlineRunContainer: (element: HTMLElement) => boolean }) {
  return serializeWorkbenchDomToMarkdown(fragment, {
    isInlineRunContainer: options.isInlineRunContainer,
  }).trim();
}

function createScratchpadImageSerializationToken(index: number) {
  return `WBSPIMG${index.toString(36)}TOKEN${Date.now().toString(36)}${Math.random().toString(36).slice(2)}END`;
}

export function serializeCollaborationScratchpadDomToMarkdown(
  root: ParentNode,
  options: { isInlineRunContainer: (element: HTMLElement) => boolean; normalizeMarkup?: (root: ParentNode) => void },
) {
  const ownerDocument = root instanceof Node ? root.ownerDocument : globalThis.document;
  const fragment = ownerDocument.createDocumentFragment();
  for (const child of Array.from(root.childNodes)) {
    if (!isAuthorMarkerElement(child)) {
      fragment.append(child.cloneNode(true));
    }
  }

  const imageMarkdownByToken = new Map<string, string>();
  let imageTokenIndex = 0;
  for (const image of Array.from(fragment.querySelectorAll("[data-collaboration-scratchpad-image]"))) {
    if (!(image instanceof HTMLElement)) {
      continue;
    }

    const href = image.dataset.href?.trim() ?? "";
    if (!isLocalScratchpadImageHref(href)) {
      image.remove();
      continue;
    }

    const token = createScratchpadImageSerializationToken(imageTokenIndex);
    imageTokenIndex += 1;
    imageMarkdownByToken.set(token, formatCollaborationScratchpadImageMarkdown({
      alt: image.dataset.alt ?? COLLABORATION_SCRATCHPAD_IMAGE_DEFAULT_ALT,
      href,
    }));

    const paragraph = ownerDocument.createElement("p");
    paragraph.textContent = token;
    image.replaceWith(paragraph);
  }

  options.normalizeMarkup?.(fragment);
  let markdown = serializeFragment(fragment, options);
  for (const [token, imageMarkdown] of imageMarkdownByToken) {
    markdown = markdown.replaceAll(token, imageMarkdown);
  }

  return normalizeCollaborationScratchpadContent(markdown, "user");
}
