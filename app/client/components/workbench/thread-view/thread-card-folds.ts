/*
 * Exports:
 * - foldCardBlocks: fold the steps leading into a card into that card's history (retried arc starts, proposal lead-ins,
 *   the todo listing before a change), then stitch back-to-back cards of one family (Git arc, todo) into one card.
 * - isCardBlock: a block drawn as one foldable card, which a later fold or stitch may absorb.
 * - getCardFoldAnchor: the card a folded or stitched block grew from.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { foldGitArcHistories, isGitArcCall } from "./thread-git-arc-retries";
import { getRenderableBlockItems, type ThreadRenderableBlock } from "./thread-render-blocks";
import { foldTodoLeadIns, isTodoCall } from "./thread-todo-folds";

type CardFamily = "gitArc" | "todo";

/** Which family of card a block draws; a card with history belongs to the card it opens from. */
function getCardFamily(block: ThreadRenderableBlock): CardFamily | null {
  if (block.kind === "cardHistory") return getCardFamily(block.success);
  if (isGitArcCall(block)) return "gitArc";
  if (isTodoCall(block)) return "todo";
  return null;
}

export function isCardBlock(block: ThreadRenderableBlock) {
  return getCardFamily(block) !== null;
}

/** Back-to-back cards of one family become one stitched card; families never mix. */
function stitchCards(blocks: readonly ThreadRenderableBlock[]): ThreadRenderableBlock[] {
  const stitched: ThreadRenderableBlock[] = [];
  let run: ThreadRenderableBlock[] = [];
  let runFamily: CardFamily | null = null;
  const flush = () => {
    if (run.length > 1) stitched.push({ blocks: run, items: run.flatMap(entry => [...getRenderableBlockItems(entry)]), kind: "cardSequence" });
    else stitched.push(...run);
    run = [];
  };
  for (const block of blocks) {
    const family = getCardFamily(block);
    if (family !== runFamily) flush();
    runFamily = family;
    if (family) run.push(block);
    else stitched.push(block);
  }
  flush();
  return stitched;
}

export function foldCardBlocks(blocks: readonly ThreadRenderableBlock[]): ThreadRenderableBlock[] {
  return stitchCards(foldTodoLeadIns(foldGitArcHistories(blocks)));
}

/** The card a folded or stitched block grew from, so it can move in from where that card sat. */
export function getCardFoldAnchor(block: ThreadRenderableBlock): ThreadItem | null {
  if (block.kind === "cardHistory") return getRenderableBlockItems(block.success)[0] ?? null;
  if (block.kind !== "cardSequence") return null;
  const [first] = block.blocks;
  return first ? getCardFoldAnchor(first) ?? getRenderableBlockItems(first)[0] ?? null : null;
}
