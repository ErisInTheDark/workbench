/*
 * Exports:
 * - WorkbenchMarkupSerializationOptions: callbacks needed to serialize editor DOM and markup signatures without coordinator globals. Keywords: workbench, markdown, serialization, callbacks.
 * - createWorkbenchMarkupSignature: create a canonical rich-text markup signature for save-guard round-trip comparisons. Keywords: workbench, markup, signature, save guard.
 * - resolveOrderedListItemOrdinals: preserve explicit item values and derive implicit continuations for ordered-list serialization. Keywords: markdown, ordered list, ordinal, serialization.
 * - serializeListItemMainText: serialize the visible markdown text for a structured list item. Keywords: workbench, markdown, list, serialization.
 * - serializeWorkbenchDomToMarkdown: serialize a normalized workbench editor DOM subtree back to markdown text. Keywords: workbench, markdown, serialization, save guard.
 */

import {
    getDirectChildDetailsElement,
    getDirectChildSummaryElement,
    getNestedBlockElementsForItem,
    isIntentionalListBreakParagraph,
    isListElement,
    isSingleBreakParagraph
} from "../dom/query/list-dom";
import {
    serializeInlineNodes,
    serializeInlineRunContainerForMarkupSignature,
} from "../editor/WorkbenchInlineFormatController";
import {
    formatBlockCommentLine,
    isBlockCommentLine,
    parseBlockCommentBody,
} from "./comment-markdown";

export interface WorkbenchMarkupSerializationOptions {
  isInlineRunContainer: (element: HTMLElement) => boolean;
  normalizeMarkup?: ((root: ParentNode) => void) | null;
}

interface SerializedBlock {
  kind: "block" | "list";
  isComment: boolean;
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

export function serializeWorkbenchDomToMarkdown(
  sourceRoot: ParentNode,
  options: WorkbenchMarkupSerializationOptions,
) {
  options.normalizeMarkup?.(sourceRoot);

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

    const text = formatParagraphText(serializeInlineNodes(inlineNodes).trimEnd());
    if (text) {
      flushPendingBreaks();
      tokens.push({
        type: "block",
        block: {
          kind: "block",
          isComment: isBlockCommentLine(text),
          text,
        },
      });
    }
    inlineNodes = [];
  };

  for (const node of sourceRoot.childNodes) {
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

    if (isIntentionalListBreakParagraph(element)) {
      flushInlineNodes();
      pendingBreakCount += 1;
      continue;
    }

    if (element.tagName === "BR") {
      flushInlineNodes();
      pendingBreakCount += 1;
      continue;
    }

    if (element instanceof HTMLElement && isSingleBreakParagraph(element)) {
      flushInlineNodes();
      pendingBreakCount += 1;
      continue;
    }

    if (BLOCK_TAGS.has(element.tagName)) {
      flushInlineNodes();
      flushPendingBreaks();
      const block = serializeBlockElement(element);
      if (block.text) {
        tokens.push({ type: "block", block });
      }
      continue;
    }

    inlineNodes.push(node);
  }

  flushInlineNodes();
  flushPendingBreaks();
  return serializeMarkdownTokens(tokens);
}

function isTrailingWhitespaceBoundaryTag(tag: string) {
  return /^(p|div|h1|h2|h3|h4|h5|h6|blockquote|li|summary)$/i.test(tag);
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

  if (element instanceof HTMLElement && isSingleBreakParagraph(element)) {
    return "<br>";
  }

  if (tag === "a") {
    const href = element.getAttribute("href");
    if (href) {
      attributes.push(`href=${JSON.stringify(href)}`);
    }
  }

  if (element instanceof HTMLElement) {
    if (element.dataset.inlineComment === "true") {
      attributes.push("data-inline-comment=true");
    }

    if (element.dataset.blockComment === "true") {
      attributes.push("data-block-comment=true");
    }
  }

  if (tag === "pre") {
    const language = element instanceof HTMLElement
      ? element.dataset.language ?? ""
      : element.getAttribute("data-language") ?? "";
    if (language) {
      attributes.push(`data-language=${JSON.stringify(language)}`);
    }
  }

  const childNodes = Array.from(element.childNodes);
  const trimLastChild = trimTrailingWhitespace || isTrailingWhitespaceBoundaryTag(tag);
  const openingTag = attributes.length > 0
    ? `<${tag} ${attributes.join(" ")}>`
    : `<${tag}>`;

  if (tag === "br" || tag === "hr") {
    return openingTag;
  }

  if (element instanceof HTMLElement && options.isInlineRunContainer(element)) {
    const children = serializeInlineRunContainerForMarkupSignature(
      element,
      trimLastChild && tag !== "pre" && tag !== "code",
    );
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

function serializeParagraph(node: Element) {
  return serializeInlineNodes(node.childNodes);
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

/** Empty visual lines are written as two spaces, which keeps their newline inside the paragraph. */
function formatParagraphText(text: string) {
  if (!text) {
    return "";
  }

  return text
    .split("\n")
    .map((line) => {
      const content = trimLineEnd(line);
      return content ? escapeBlockStart(content) : "  ";
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

export function serializeListItemMainText(item: Element) {
  const details = getDirectChildDetailsElement(item);
  if (details) {
    const summary = getDirectChildSummaryElement(details);
    return summary ? serializeParagraph(summary).trim() : "";
  }

  const contentNodes = Array.from(item.childNodes).filter((node) => {
    return !(node instanceof Element && isListElement(node));
  });
  return serializeInlineNodes(contentNodes).trim();
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

function serializeListElement(node: Element, indent = 0): string {
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
      const prefix = listType === "ol" ? `${orderedOrdinals[index]}. ` : "- ";
      const [firstLine = "", ...continuationLines] = serializeListItemMainText(item).split("\n");
      const continuationIndent = " ".repeat(indent + prefix.length);
      const text = joinWithHardBreaks([
        trimLineEnd(firstLine),
        ...continuationLines.map((line) => `${continuationIndent}${trimLineEnd(line)}`),
      ]);
      const line = `${" ".repeat(indent)}${prefix}${text}`.trimEnd();
      const nested: string = getNestedBlockElementsForItem(item)
        .map((childBlock) => serializeNestedListChildBlock(childBlock, indent + 2))
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

function serializeNestedListChildBlock(element: Element, indent: number): string {
  const markdown: string = isListElement(element)
    ? serializeListElement(element)
    : serializeBlockElement(element).text;

  return indentMarkdownLines(markdown, indent);
}

function getCodeBlockFence(code: string) {
  const backtickRuns = code.match(/`+/g) ?? [];
  const fenceLength = Math.max(3, ...backtickRuns.map((run) => run.length + 1));
  return "`".repeat(fenceLength);
}

function serializeBlockElement(node: Element): SerializedBlock {
  const tag = node.tagName.toLowerCase();
  const rawText = node.textContent ?? "";
  const parsedCommentBody = parseBlockCommentBody(rawText);

  if (node instanceof HTMLElement && (node.dataset.blockComment === "true" || parsedCommentBody !== null)) {
    // Block comment bodies render as literal text, so they are written without markdown escapes.
    const commentBody = parsedCommentBody ?? rawText.replaceAll(" ", " ").replace(/\s+/g, " ").trim();
    return {
      kind: "block",
      isComment: true,
      text: formatBlockCommentLine(commentBody),
    };
  }

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return {
        kind: "block",
        isComment: false,
        text: `${"#".repeat(Number.parseInt(tag.slice(1), 10))} ${joinWithHardBreaks(serializeParagraph(node).trim().split("\n").map(trimLineEnd))}`.trimEnd(),
      };
    case "ul":
      return {
        kind: "list",
        isComment: false,
        text: serializeListElement(node),
      };
    case "ol":
      return {
        kind: "list",
        isComment: false,
        text: serializeListElement(node),
      };
    case "blockquote":
      return {
        kind: "block",
        isComment: false,
        text: serializeParagraph(node)
          .split("\n")
          .map((line) => `> ${line}`.trimEnd())
          .join("\n"),
      };
    case "pre": {
      const language = node instanceof HTMLElement ? node.dataset.language ?? "" : "";
      const code = node.textContent?.replace(/\n$/, "") ?? "";
      const fence = getCodeBlockFence(code);
      return {
        kind: "block",
        isComment: false,
        text: `${fence}${language}\n${code}\n${fence}`,
      };
    }
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
        text: formatParagraphText(serializeParagraph(node)),
      };
  }
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
      // Lists that touch in the DOM differ in type (same-type ones merge), and a blank line between them reparses as a list break.
      const baseSeparator = touchesComment || (betweenLists && pendingBreakCount === 0) ? "\n" : "\n\n";
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

  return `${markdown}\n`;
}
