/*
 * Exports:
 * - holdsInside: whether a shown block may still be streaming inside (containers) rather than complete.
 * - holdStreamingBlocks: the blocks of still-streaming markdown that per-paragraph reveal shows; only complete blocks, headings with complete content after them, and containers with complete content inside.
 */

import type { ParsedBlock } from "./markdown-parse";

const CONTAINER_TYPES: ReadonlySet<ParsedBlock["type"]> = new Set(["details", "notice", "plan"]);

/** A shown container may still be streaming inside, so its content keeps being held; every other shown block is complete. */
export function holdsInside(block: ParsedBlock) {
  return CONTAINER_TYPES.has(block.type);
}

function isContent(block: ParsedBlock) {
  return block.type !== "break" && block.type !== "list-break";
}

function hasContent(blocks: readonly ParsedBlock[]) {
  return blocks.some(isContent);
}

/** The frontier block is still arriving; what of it, if anything, is complete enough to show. */
function heldFrontier(block: ParsedBlock, parseChildren: (markdown: string) => ParsedBlock[]): ParsedBlock | null {
  if (block.type === "ul" || block.type === "ol") {
    return block.items.length > 1 ? { ...block, items: block.items.slice(0, -1) } : null;
  }
  if (holdsInside(block) && "text" in block) {
    return hasContent(holdStreamingBlocks(parseChildren(block.text), parseChildren)) ? block : null;
  }
  return null;
}

/**
 * A block counts as complete once anything after it starts arriving, so the last content block is held.
 * Containers show once their own held content is non-empty (their content is held again as it renders);
 * trailing headings wait for complete content beneath them.
 */
export function holdStreamingBlocks(blocks: readonly ParsedBlock[], parseChildren: (markdown: string) => ParsedBlock[]): ParsedBlock[] {
  const frontierIndex = blocks.findLastIndex(isContent);
  if (frontierIndex < 0) return [];
  const frontier = heldFrontier(blocks[frontierIndex]!, parseChildren);
  const held = frontier ? [...blocks.slice(0, frontierIndex), frontier] : blocks.slice(0, frontierIndex);
  let end = held.length;
  while (end > 0 && (!isContent(held[end - 1]!) || held[end - 1]!.type === "heading")) end -= 1;
  return held.slice(0, end);
}
