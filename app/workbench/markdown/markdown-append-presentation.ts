/*
 * Exports:
 * - ThreadMarkdownAppendRenderTarget/MarkdownAppendPresentation: fail-closed presentation description for one compatible Markdown append. Keywords: markdown, append, reveal, presentation.
 * - deriveMarkdownAppendPresentation: compare block and inline AST semantics before isolating one safe rendered suffix. Keywords: markdown, AST, prefix, suffix.
 */
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  parseBlocks,
  parseInlineMarkdown,
  parseThreadStateChangeMode,
  type MarkdownParseOptions,
  type ParsedBlock,
  type ParsedInlineNode,
} from "./markdown-parse";

export type ThreadMarkdownAppendRenderTarget =
  | {
    blockIndex: number;
    kind: "text";
    nodePath: number[];
    prefixLength: number;
    revisionKey: string;
  }
  | {
    blockIndex: number;
    kind: "inlineTail";
    revisionKey: string;
    startNodeIndex: number;
  };

export type MarkdownAppendPresentation =
  | { kind: "instant" }
  | { kind: "append"; target: ThreadMarkdownAppendRenderTarget };

type DirectInlineBlock = Extract<ParsedBlock, { type: "blockquote" | "heading" | "paragraph" }>;

function isDirectInlineBlock(block: ParsedBlock | undefined): block is DirectInlineBlock {
  return block?.type === "blockquote" || block?.type === "heading" || block?.type === "paragraph";
}

function directBlockSemanticsEqual(previous: DirectInlineBlock, next: DirectInlineBlock) {
  if (previous.type !== next.type) return false;
  return previous.type !== "heading"
    || next.type === "heading" && previous.level === next.level;
}

function inlineNodeChildren(node: ParsedInlineNode) {
  switch (node.type) {
    case "strong":
    case "em":
    case "delete":
    case "insert":
    case "link":
    case "inlineComment":
      return node.children;
    default:
      return null;
  }
}

function inlineNodeSemanticsEqual(previous: ParsedInlineNode, next: ParsedInlineNode) {
  if (previous.type !== next.type) return false;
  if (previous.type === "link" && next.type === "link") {
    return previous.external === next.external && previous.href === next.href;
  }
  return previous.type === "strong"
    || previous.type === "em"
    || previous.type === "delete"
    || previous.type === "insert"
    || previous.type === "inlineComment";
}

function findFinalTextExtension(
  previousNodes: ParsedInlineNode[],
  nextNodes: ParsedInlineNode[],
  path: number[] = [],
): { nodePath: number[]; prefixLength: number } | null {
  if (previousNodes.length !== nextNodes.length || previousNodes.length === 0) return null;
  const lastIndex = previousNodes.length - 1;
  if (!areDeeplyEqual(previousNodes.slice(0, lastIndex), nextNodes.slice(0, lastIndex))) return null;
  const previous = previousNodes[lastIndex]!;
  const next = nextNodes[lastIndex]!;
  if (previous.type === "text" && next.type === "text") {
    return next.text.length > previous.text.length && next.text.startsWith(previous.text)
      ? { nodePath: [...path, lastIndex], prefixLength: previous.text.length }
      : null;
  }
  if (!inlineNodeSemanticsEqual(previous, next)) return null;
  const previousChildren = inlineNodeChildren(previous);
  const nextChildren = inlineNodeChildren(next);
  return previousChildren && nextChildren
    ? findFinalTextExtension(previousChildren, nextChildren, [...path, lastIndex])
    : null;
}

function inlineVisibleText(node: ParsedInlineNode): string {
  switch (node.type) {
    case "text":
    case "code":
    case "knownSkillMention":
      return node.text;
    case "break":
      return "\n";
    case "strong":
    case "em":
    case "delete":
    case "insert":
    case "link":
    case "inlineComment":
      return node.children.map(inlineVisibleText).join("");
    case "projectFileLink":
      return node.label ?? node.relativePath;
    case "threadIcon":
      return "";
  }
}

function appendedInlineTailStart(previousNodes: ParsedInlineNode[], nextNodes: ParsedInlineNode[]) {
  if (nextNodes.length <= previousNodes.length) return null;
  if (!areDeeplyEqual(previousNodes, nextNodes.slice(0, previousNodes.length))) return null;
  return nextNodes.slice(previousNodes.length).some((node) => inlineVisibleText(node).length > 0)
    ? previousNodes.length
    : null;
}

export function deriveMarkdownAppendPresentation({
  nextMarkdown,
  options = {},
  previousMarkdown,
  reducedMotion = false,
}: {
  nextMarkdown: string;
  options?: MarkdownParseOptions;
  previousMarkdown: string | null;
  reducedMotion?: boolean;
}): MarkdownAppendPresentation {
  if (
    reducedMotion
    || previousMarkdown === null
    || nextMarkdown.length <= previousMarkdown.length
    || !nextMarkdown.startsWith(previousMarkdown)
  ) {
    return { kind: "instant" };
  }

  const threadOptions = { ...options, profile: "thread" as const };
  const previousBlocks = parseBlocks(previousMarkdown, threadOptions);
  const nextBlocks = parseBlocks(nextMarkdown, threadOptions);
  const revisionKey = `${previousMarkdown.length}:${nextMarkdown.length}`;

  if (previousBlocks.length === nextBlocks.length && previousBlocks.length > 0) {
    const blockIndex = previousBlocks.length - 1;
    if (!areDeeplyEqual(previousBlocks.slice(0, blockIndex), nextBlocks.slice(0, blockIndex))) {
      return { kind: "instant" };
    }
    const previousBlock = previousBlocks[blockIndex];
    const nextBlock = nextBlocks[blockIndex];
    if (
      !isDirectInlineBlock(previousBlock)
      || !isDirectInlineBlock(nextBlock)
      || !directBlockSemanticsEqual(previousBlock, nextBlock)
      || parseThreadStateChangeMode(previousBlock.text, threadOptions)
      || parseThreadStateChangeMode(nextBlock.text, threadOptions)
    ) {
      return { kind: "instant" };
    }
    const previousNodes = parseInlineMarkdown(previousBlock.text, threadOptions);
    const nextNodes = parseInlineMarkdown(nextBlock.text, threadOptions);
    const previousVisibleText = previousNodes.map(inlineVisibleText).join("");
    const nextVisibleText = nextNodes.map(inlineVisibleText).join("");
    if (nextVisibleText.length <= previousVisibleText.length || !nextVisibleText.startsWith(previousVisibleText)) {
      return { kind: "instant" };
    }
    const extension = findFinalTextExtension(previousNodes, nextNodes);
    if (extension) {
      return {
        kind: "append",
        target: { blockIndex, kind: "text", revisionKey, ...extension },
      };
    }
    const startNodeIndex = appendedInlineTailStart(previousNodes, nextNodes);
    return startNodeIndex === null
      ? { kind: "instant" }
      : { kind: "append", target: { blockIndex, kind: "inlineTail", revisionKey, startNodeIndex } };
  }

  if (nextBlocks.length === previousBlocks.length + 1 && areDeeplyEqual(previousBlocks, nextBlocks.slice(0, -1))) {
    const blockIndex = nextBlocks.length - 1;
    const nextBlock = nextBlocks[blockIndex];
    if (
      isDirectInlineBlock(nextBlock)
      && !parseThreadStateChangeMode(nextBlock.text, threadOptions)
      && parseInlineMarkdown(nextBlock.text, threadOptions).some((node) => inlineVisibleText(node).length > 0)
    ) {
      return {
        kind: "append",
        target: { blockIndex, kind: "inlineTail", revisionKey, startNodeIndex: 0 },
      };
    }
  }
  return { kind: "instant" };
}
