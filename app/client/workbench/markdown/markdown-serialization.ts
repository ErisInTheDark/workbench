/*
 * Exports:
 * - WorkbenchMarkupSerializationOptions: callbacks and file style needed to serialize editor DOM and markup signatures.
 * - createWorkbenchMarkupSignature: create a canonical rich-text markup signature for save-guard round-trip comparisons.
 * - resolveOrderedListItemOrdinals: preserve explicit item values and derive implicit continuations for ordered-list serialization.
 * - serializeListItemMainText: serialize the visible markdown text for a structured list item.
 * - serializeWorkbenchDomToMarkdown: serialize a normalized editor DOM subtree back to a markdown file.
 * - serializeBlocksToMarkdown: serialize detached top-level blocks as a markdown fragment, as suggestions store them.
 */

import {
    getDirectChildDetailsElement,
    getDirectChildSummaryElement,
    getNestedBlockElementsForItem,
    isIntentionalListBreakParagraph,
    isListElement,
    isSingleBreakParagraph
} from "../dom/query/list-dom";
import { readCodeBlockText } from "../dom/mutation/code-block-dom";
import { readTableAlignments, rowCells, TABLE_ALIGN_ATTRIBUTE, tableRows } from "../dom/mutation/table-dom";
import { serializeCommentThreadForMarkupSignature, serializeInlineRunContainerForMarkupSignature } from "../editor/inline-leaves";
import { serializeInlineNodes } from "../editor/inline-markdown-serialization";
import { formatComment, parseCommentLine, sameComments } from "./comment-markdown";
import { markdownToHtml } from "./markdown-html-render";
import { parseBlocks } from "./markdown-parse";
import { applyDocumentLineStyle, DEFAULT_MARKDOWN_STYLE, type MarkdownStyle } from "./markdown-style";
import { formatSuggestion } from "./markdown-suggestion";
import {
    REVIEW_ATTRIBUTES,
    getSuggestionId,
    getSuggestionOld,
    isCommentThreadElement,
    readThreadComments,
} from "./review-markup";

export interface WorkbenchMarkupSerializationOptions {
  isInlineRunContainer: (element: HTMLElement) => boolean;
  normalizeMarkup?: ((root: ParentNode) => void) | null;
  style?: MarkdownStyle;
}

interface SerializedBlock {
  isComment: boolean;
  kind: "block" | "list";
  /** The block was read right below the block before it, without a blank line between. */
  tight: boolean;
  text: string;
}

type SerializedMarkdownToken =
  | { type: "block"; block: SerializedBlock }
  | { type: "break"; count: number };

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "UL",
  "OL",
  "PRE",
  "BLOCKQUOTE",
  "HR",
  "TABLE",
]);

export function createWorkbenchMarkupSignature(
  root: ParentNode,
  options: WorkbenchMarkupSerializationOptions,
) {
  return Array.from(root.childNodes)
    .map((node) => serializeMarkupNode(node, options))
    .filter(Boolean)
    .join("");
}

function isTrailingWhitespaceBoundaryTag(tag: string) {
  return /^(p|div|h1|h2|h3|h4|h5|h6|blockquote|li|summary|td|th)$/i.test(tag);
}

function serializeMarkupNode(
  node: Node,
  options: WorkbenchMarkupSerializationOptions,
  trimTrailingWhitespace = false,
): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "")
      .replaceAll("\u00a0", " ")
      .replace(/[ \t]+$/g, trimTrailingWhitespace ? "" : "$&");
    return text ? `text(${JSON.stringify(text)})` : "";
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const attributes = [];

  if (element instanceof HTMLElement && isCommentThreadElement(element)) {
    return serializeCommentThreadForMarkupSignature(element);
  }

  if (element instanceof HTMLElement && isSingleBreakParagraph(element)) {
    return "<br>";
  }

  if (tag === "a") {
    const href = element.getAttribute("href");
    if (href) {
      attributes.push(`href=${JSON.stringify(href)}`);
    }
  }

  if (element instanceof HTMLElement && getSuggestionId(element) !== null) {
    attributes.push(`suggestion-old=${JSON.stringify(getSuggestionOld(element))}`);
  }

  if (tag === "pre") {
    const language = element.getAttribute("data-language") ?? "";
    if (language) {
      attributes.push(`data-language=${JSON.stringify(language)}`);
    }
  }

  if (tag === "th" && element.getAttribute(TABLE_ALIGN_ATTRIBUTE)) {
    attributes.push(`${TABLE_ALIGN_ATTRIBUTE}=${JSON.stringify(element.getAttribute(TABLE_ALIGN_ATTRIBUTE))}`);
  }

  const childNodes = Array.from(element.childNodes);
  const trimLastChild = trimTrailingWhitespace || isTrailingWhitespaceBoundaryTag(tag);
  const openingTag = attributes.length > 0
    ? `<${tag} ${attributes.join(" ")}>`
    : `<${tag}>`;

  if (tag === "br" || tag === "hr") {
    return openingTag;
  }

  // Code is plain text whatever holds it, and only its sentinel-free text reaches markdown.
  if (tag === "pre") {
    return `${openingTag}text(${JSON.stringify(readCodeBlockText(element))})</pre>`;
  }

  if (element instanceof HTMLElement && options.isInlineRunContainer(element)) {
    const children = serializeInlineRunContainerForMarkupSignature(
      element,
      trimLastChild && tag !== "code",
    );
    // A cell is one line: the break an empty cell keeps open has no markdown form.
    if (tag === "td" || tag === "th") {
      return `${openingTag}${children.content}</${tag}>`;
    }
    return `${"<br>".repeat(children.leadingBreakCount)}${openingTag}${children.content}</${tag}>${"<br>".repeat(children.trailingBreakCount)}`;
  }

  const lastChildIndex = childNodes.length - 1;
  const children = childNodes
    .map((childNode, index) => serializeMarkupNode(
      childNode,
      options,
      trimLastChild && index === lastChildIndex && tag !== "pre" && tag !== "code",
    ))
    .join("");

  return `${openingTag}${children}</${tag}>`;
}

const SOURCE_SIGNATURE_LIMIT = 4000;
const sourceSignatures = new Map<string, string>();

/** The canonical structure a block's source renders to, so an unchanged block can be recognized and written back verbatim. */
function getSourceSignature(source: string, options: WorkbenchMarkupSerializationOptions) {
  const cached = sourceSignatures.get(source);
  if (cached !== undefined) {
    return cached;
  }

  const root = document.createElement("div");
  root.innerHTML = markdownToHtml(source);
  options.normalizeMarkup?.(root);
  const signature = createWorkbenchMarkupSignature(root, options);
  if (sourceSignatures.size >= SOURCE_SIGNATURE_LIMIT) {
    sourceSignatures.clear();
  }
  sourceSignatures.set(source, signature);
  return signature;
}

function readPreservedSource(element: Element, options: WorkbenchMarkupSerializationOptions) {
  const source = element.getAttribute(REVIEW_ATTRIBUTES.source);
  if (source === null) {
    return null;
  }

  if (isCommentThreadElement(element)) {
    const lines = source.split("\n").map(parseCommentLine);
    const comments = lines.every((line) => line !== null) ? lines.flat() : null;
    return comments && sameComments(comments, readThreadComments(element as HTMLElement)) ? source : null;
  }

  let compared = element;
  if (getSuggestionId(element) !== null) {
    compared = element.cloneNode(true) as Element;
    compared.removeAttribute(REVIEW_ATTRIBUTES.suggestion);
  }
  return getSourceSignature(source, options) === serializeMarkupNode(compared, options) ? source : null;
}

const tightJoins = new Map<string, boolean>();

/** Whether two blocks written one line apart still read back as the same two blocks. */
function canJoinTightly(previous: string, next: string) {
  const key = `${previous}\u0000${next}`;
  let joinable = tightJoins.get(key);
  if (joinable === undefined) {
    const contentBlocks = (markdown: string) => parseBlocks(markdown).filter((block) => block.type !== "break" && block.type !== "list-break");
    joinable = JSON.stringify(contentBlocks(`${previous}\n${next}`)) === JSON.stringify([...contentBlocks(previous), ...contentBlocks(next)]);
    if (tightJoins.size >= SOURCE_SIGNATURE_LIMIT) tightJoins.clear();
    tightJoins.set(key, joinable);
  }
  return joinable;
}

function serializeParagraph(node: Element, style: MarkdownStyle) {
  return serializeInlineNodes(node.childNodes, style);
}

const BLOCK_START_PATTERNS = [
  /^#{1,6}(?:[ \t]|$)/,
  /^>/,
  /^[-*+](?:[ \t]|$)/,
  /^\d+[.)](?:[ \t]|$)/,
  /^`{3,}[^`]*$/,
  /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
];

/** A paragraph line that would open another block when reparsed gets a backslash before its first character. */
function escapeBlockStart(line: string) {
  const indent = line.match(/^ */)?.[0] ?? "";
  const content = line.slice(indent.length);
  return BLOCK_START_PATTERNS.some((pattern) => pattern.test(content)) ? `${indent}\\${content}` : line;
}

const TABLE_DELIMITER_LINE = /^ *\|? *:?-{3,}:? *(?:\| *:?-{3,}:? *)*\|? *$/u;

/** Empty visual lines are written as two spaces, which keeps their newline inside the paragraph. */
function formatParagraphText(text: string) {
  if (!text) {
    return "";
  }

  const lines = text.split("\n").map(trimLineEnd);
  return lines
    .map((content, index) => {
      if (!content) return "  ";
      // A pipe line over a delimiter line would read back as a table.
      if (content.includes("|") && TABLE_DELIMITER_LINE.test(lines[index + 1] ?? "")) {
        return escapeTablePipes(content);
      }
      return escapeBlockStart(content);
    })
    .join("\n");
}

/** Spaces before a line break never render, and two of them would read as a hard break. */
function trimLineEnd(line: string) {
  return line.replace(/[ \t]+$/, "");
}

/** Joins soft-broken lines of a single-line block with hard breaks: two spaces before each kept newline. */
function joinWithHardBreaks(lines: readonly string[]) {
  return lines.map((line, index) => index < lines.length - 1 ? `${line}  ` : line).join("\n");
}

export function serializeListItemMainText(item: Element, style: MarkdownStyle = DEFAULT_MARKDOWN_STYLE) {
  const details = getDirectChildDetailsElement(item);
  if (details) {
    const summary = getDirectChildSummaryElement(details);
    return summary ? serializeParagraph(summary, style).trim() : "";
  }

  const contentNodes = Array.from(item.childNodes).filter((node) => {
    return !(node instanceof Element && isListElement(node));
  });
  return serializeInlineNodes(contentNodes, style).trim();
}

function parseOrderedListOrdinal(value: string | null) {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  return BigInt(value);
}

export function resolveOrderedListItemOrdinals(
  valueAttributes: readonly (string | null)[],
  startAttribute: string | null,
) {
  let nextOrdinal = parseOrderedListOrdinal(startAttribute) ?? BigInt(1);

  return valueAttributes.map((valueAttribute) => {
    const explicitOrdinal = parseOrderedListOrdinal(valueAttribute);
    const ordinal = explicitOrdinal === null ? nextOrdinal.toString() : valueAttribute!;
    nextOrdinal = (explicitOrdinal ?? nextOrdinal) + BigInt(1);
    return ordinal;
  });
}

function serializeListElement(node: Element, style: MarkdownStyle, indent = 0): string {
  const listType = node.tagName.toLowerCase();
  if (listType !== "ul" && listType !== "ol") {
    return "";
  }

  const items = Array.from(node.children)
    .filter((child): child is HTMLLIElement => child instanceof HTMLLIElement);
  const orderedOrdinals = listType === "ol"
    ? resolveOrderedListItemOrdinals(
      items.map((item) => item.getAttribute("value")),
      node.getAttribute("start"),
    )
    : [];

  return items
    .map((item, index) => {
      const prefix = listType === "ol" ? `${orderedOrdinals[index]}${style.orderedDelimiter} ` : `${style.bullet} `;
      const [firstLine = "", ...continuationLines] = serializeListItemMainText(item, style).split("\n");
      const continuationIndent = " ".repeat(indent + prefix.length);
      const text = joinWithHardBreaks([
        trimLineEnd(firstLine),
        ...continuationLines.map((line) => `${continuationIndent}${trimLineEnd(line)}`),
      ]);
      const line = `${" ".repeat(indent)}${prefix}${text}`.trimEnd();
      const nested: string = getNestedBlockElementsForItem(item)
        .map((childBlock) => serializeNestedListChildBlock(childBlock, style, indent + style.listIndent))
        .filter(Boolean)
        .join("\n");

      return nested ? `${line}\n${nested}` : line;
    })
    .join("\n");
}

function indentMarkdownLines(markdown: string, indent: number) {
  const prefix = " ".repeat(indent);
  return markdown
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line ? `${prefix}${line}` : line)
    .join("\n");
}

function serializeNestedListChildBlock(element: Element, style: MarkdownStyle, indent: number): string {
  const markdown: string = isListElement(element)
    ? serializeListElement(element, style)
    : serializeBlockElement(element, style).text;

  return indentMarkdownLines(markdown, indent);
}

/** A literal pipe would split its cell; code spans are read whole, so pipes inside them stay as written. */
function escapeTablePipes(text: string) {
  let escaped = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\\") {
      escaped += text.slice(index, index + 2);
      index += 1;
    } else if (character === "`") {
      const fence = text.slice(index).match(/^`+/u)![0];
      const close = text.indexOf(fence, index + fence.length);
      const end = close === -1 ? index + fence.length : close + fence.length;
      escaped += text.slice(index, end);
      index = end - 1;
    } else {
      escaped += character === "|" ? "\\|" : character;
    }
  }
  return escaped;
}

const DELIMITER_CELLS: Record<string, string> = { center: ":---:", left: ":---", right: "---:" };

function serializeTableElement(table: HTMLTableElement, style: MarkdownStyle) {
  const rows = tableRows(table);
  if (!rows.length) {
    return "";
  }

  const alignments = readTableAlignments(table);
  const columns = Math.max(1, alignments.length, ...rows.map((row) => rowCells(row).length));
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const rowLine = (row: HTMLTableRowElement) => {
    const cells = rowCells(row);
    return line(Array.from({ length: columns }, (_, column) => {
      const cell = cells[column];
      return cell ? escapeTablePipes(serializeInlineNodes(cell.childNodes, style).trim().replace(/[ \t]*\n[ \t]*/gu, " ")) : "";
    }));
  };
  const delimiter = line(Array.from({ length: columns }, (_, column) => DELIMITER_CELLS[alignments[column] ?? ""] ?? "---"));
  return [rowLine(rows[0]!), delimiter, ...rows.slice(1).map(rowLine)].join("\n");
}

function getCodeBlockFence(code: string) {
  const backtickRuns = code.match(/`+/g) ?? [];
  const fenceLength = Math.max(3, ...backtickRuns.map((run) => run.length + 1));
  return "`".repeat(fenceLength);
}

function serializeBlockElement(node: Element, style: MarkdownStyle): Omit<SerializedBlock, "tight"> {
  const tag = node.tagName.toLowerCase();

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number.parseInt(tag.slice(1), 10);
      const text = joinWithHardBreaks(serializeParagraph(node, style).trim().split("\n").map(trimLineEnd));
      // An underline needs text above it, so an empty heading keeps its `#` form.
      const underlined = style.setextHeadings && level <= 2 && text.trim();
      return {
        kind: "block",
        isComment: false,
        text: underlined
          ? `${text}\n${(level === 1 ? "=" : "-").repeat(Math.max(3, ...text.split("\n").map((line) => line.trimEnd().length)))}`
          : `${"#".repeat(level)} ${text}`.trimEnd(),
      };
    }
    case "ul":
    case "ol":
      return {
        kind: "list",
        isComment: false,
        text: serializeListElement(node, style),
      };
    case "blockquote":
      return {
        kind: "block",
        isComment: false,
        text: serializeParagraph(node, style)
          .split("\n")
          .map((line) => `> ${line}`.trimEnd())
          .join("\n"),
      };
    case "pre": {
      const language = node.getAttribute("data-language") ?? "";
      const code = readCodeBlockText(node);
      const fence = getCodeBlockFence(code);
      return {
        kind: "block",
        isComment: false,
        text: `${fence}${language}\n${code}\n${fence}`,
      };
    }
    case "table":
      return {
        kind: "block",
        isComment: false,
        text: serializeTableElement(node as HTMLTableElement, style),
      };
    case "hr":
      return {
        kind: "block",
        isComment: false,
        text: "---",
      };
    case "div":
    case "p":
    default:
      return {
        kind: "block",
        isComment: false,
        text: formatParagraphText(serializeParagraph(node, style)),
      };
  }
}

function serializeTopLevelElement(element: Element, options: WorkbenchMarkupSerializationOptions): SerializedBlock {
  const style = options.style ?? DEFAULT_MARKDOWN_STYLE;
  const preserved = readPreservedSource(element, options);
  const isComment = isCommentThreadElement(element);
  const tight = element.getAttribute(REVIEW_ATTRIBUTES.sourceTight) === "true";
  if (preserved !== null) {
    return { isComment, kind: isListElement(element) ? "list" : "block", text: preserved, tight };
  }

  if (isComment) {
    return { isComment: true, kind: "block", text: readThreadComments(element as HTMLElement).map(formatComment).join("\n"), tight };
  }

  return { ...serializeBlockElement(element, style), tight };
}

/** A suggestion is every node from its first tagged block to its last; the blocks between are its new side too. */
function collectSuggestionGroup(nodes: readonly ChildNode[], start: number, id: string) {
  let end = start;
  for (let index = start; index < nodes.length; index += 1) {
    if (getSuggestionId(nodes[index]) === id) end = index;
  }
  return nodes.slice(start, end + 1);
}

function serializeSuggestionGroup(group: readonly ChildNode[], options: WorkbenchMarkupSerializationOptions): SerializedBlock | null {
  const first = group.find((node): node is HTMLElement => getSuggestionId(node) !== null)!;
  const old = getSuggestionOld(first);
  const next = serializeMarkdownTokens(collectTokens(group, options, { insideSuggestion: true }));
  const text = next === old ? next : formatSuggestion({ old, new: next });
  return text ? { isComment: false, kind: "block", text, tight: false } : null;
}

function collectTokens(
  nodes: readonly ChildNode[],
  options: WorkbenchMarkupSerializationOptions,
  { insideSuggestion = false }: { insideSuggestion?: boolean } = {},
) {
  const style = options.style ?? DEFAULT_MARKDOWN_STYLE;
  const tokens: SerializedMarkdownToken[] = [];
  let inlineNodes: Node[] = [];
  let pendingBreakCount = 0;

  const flushPendingBreaks = () => {
    if (!pendingBreakCount) {
      return;
    }

    tokens.push({ type: "break", count: pendingBreakCount });
    pendingBreakCount = 0;
  };

  const flushInlineNodes = () => {
    if (!inlineNodes.length) {
      return;
    }

    const text = formatParagraphText(serializeInlineNodes(inlineNodes, style).trimEnd());
    if (text) {
      flushPendingBreaks();
      tokens.push({ type: "block", block: { kind: "block", isComment: false, text, tight: false } });
    }
    inlineNodes = [];
  };

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent ?? "").trim()) {
        inlineNodes.push(node);
      }
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const element = node as Element;
    const suggestionId = insideSuggestion ? null : getSuggestionId(element);
    if (suggestionId !== null) {
      flushInlineNodes();
      flushPendingBreaks();
      const group = collectSuggestionGroup(nodes, index, suggestionId);
      index += group.length - 1;
      const block = serializeSuggestionGroup(group, options);
      if (block) {
        tokens.push({ type: "block", block });
      }
      continue;
    }

    if (
      isIntentionalListBreakParagraph(element)
      || element.tagName === "BR"
      || (element instanceof HTMLElement && isSingleBreakParagraph(element))
    ) {
      flushInlineNodes();
      pendingBreakCount += 1;
      continue;
    }

    if (BLOCK_TAGS.has(element.tagName) || isCommentThreadElement(element)) {
      flushInlineNodes();
      flushPendingBreaks();
      const block = serializeTopLevelElement(element, options);
      if (block.text) {
        tokens.push({ type: "block", block });
      }
      continue;
    }

    inlineNodes.push(node);
  }

  flushInlineNodes();
  flushPendingBreaks();
  return tokens;
}

function serializeMarkdownTokens(tokens: SerializedMarkdownToken[]) {
  let markdown = "";
  let pendingBreakCount = 0;
  let previousBlock: SerializedBlock | null = null;

  for (const token of tokens) {
    if (token.type === "break") {
      pendingBreakCount += token.count;
      continue;
    }

    if (!token.block.text) {
      pendingBreakCount = 0;
      continue;
    }

    if (!previousBlock) {
      if (pendingBreakCount > 0 && token.block.isComment) {
        markdown += "\n".repeat(pendingBreakCount);
      }
      markdown += token.block.text;
    } else {
      const touchesComment = previousBlock.isComment || token.block.isComment;
      const betweenLists = previousBlock.kind === "list" && token.block.kind === "list";
      // A block read right below its predecessor stays there while the pair still reads back as the same two blocks.
      const rejoinsSource = !touchesComment
        && pendingBreakCount === 0
        && token.block.tight
        && canJoinTightly(previousBlock.text, token.block.text);
      // Lists that touch in the DOM differ in type (same-type ones merge), and a blank line between them reparses as a list break.
      const baseSeparator = touchesComment || rejoinsSource || (betweenLists && pendingBreakCount === 0) ? "\n" : "\n\n";
      const extraBreakCount = touchesComment
        ? pendingBreakCount
        : betweenLists
          ? Math.max(0, pendingBreakCount - 1)
          : pendingBreakCount;
      markdown += `${baseSeparator}${"\n".repeat(extraBreakCount)}${token.block.text}`;
    }

    previousBlock = token.block;
    pendingBreakCount = 0;
  }

  if (pendingBreakCount > 0 && previousBlock?.isComment) {
    markdown += "\n".repeat(pendingBreakCount);
  }

  return markdown;
}

function serializeNodes(nodes: readonly ChildNode[], options: WorkbenchMarkupSerializationOptions) {
  return serializeMarkdownTokens(collectTokens(nodes, options));
}

export function serializeWorkbenchDomToMarkdown(
  sourceRoot: ParentNode,
  options: WorkbenchMarkupSerializationOptions,
) {
  options.normalizeMarkup?.(sourceRoot);
  const markdown = `${serializeNodes(Array.from(sourceRoot.childNodes), options)}\n`;
  return applyDocumentLineStyle(markdown, options.style ?? DEFAULT_MARKDOWN_STYLE);
}

export function serializeBlocksToMarkdown(blocks: readonly Element[], options: WorkbenchMarkupSerializationOptions) {
  const root = document.createElement("div");
  for (const block of blocks) {
    const copy = block.cloneNode(true) as Element;
    copy.removeAttribute(REVIEW_ATTRIBUTES.suggestion);
    copy.removeAttribute(REVIEW_ATTRIBUTES.suggestionOld);
    root.append(copy);
  }
  options.normalizeMarkup?.(root);
  return serializeNodes(Array.from(root.childNodes), options);
}
