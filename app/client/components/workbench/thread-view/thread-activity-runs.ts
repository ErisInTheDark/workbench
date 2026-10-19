/*
 * Exports:
 * - buildActivityRuns: fold consecutive reasoning, plain commands, file changes and web searches into activity runs; every other block stays a boundary.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import {
  buildCommandSequenceRenderSegments,
  isBrowseCommandItem,
  type ActivitySegment,
  type ThreadRenderableBlock,
} from "./thread-render-blocks";

type ActivityRunBlock = Extract<ThreadRenderableBlock, { kind: "activityRun" }>;

type CommandContext = Omit<Parameters<typeof buildCommandSequenceRenderSegments>[0], "items">;

/** Plain commands join runs; lifecycle commands (arc, subagents, titles, approvals, Browse) keep their own rows and end the run. */
function splitCommandBlock(block: Extract<ThreadRenderableBlock, { kind: "commandSequence" }>, context: CommandContext) {
  return buildCommandSequenceRenderSegments({ items: block.items, ...context }).flatMap<ActivitySegment | ThreadRenderableBlock>(segment => {
    if (segment.kind !== "commands") {
      if (segment.kind === "approval") return [{ items: segment.items, kind: "commandSequence" }];
      if (segment.kind === "subagentWait") return [{ items: segment.group.entries.map(entry => entry.item), kind: "commandSequence" }];
      return [{ items: [segment.item], kind: "commandSequence" }];
    }
    const pieces: Array<ActivitySegment | ThreadRenderableBlock> = [];
    for (const item of segment.items) {
      if (isBrowseCommandItem({ item, ...context })) pieces.push({ items: [item], kind: "commandSequence" });
      else pieces.push({ items: [item], kind: "commands" });
    }
    return pieces;
  });
}

function toSegments(block: ThreadRenderableBlock, context: CommandContext): Array<ActivitySegment | ThreadRenderableBlock> {
  switch (block.kind) {
    case "reasoningSequence": return block.items.map(item => ({ item, kind: "reasoning" as const }));
    case "fileChangeSequence": return [{ items: block.items, kind: "files" }];
    case "webSearchSequence": return [{ items: block.items, kind: "webSearch" }];
    case "commandSequence": return splitCommandBlock(block, context);
    default: return [block];
  }
}

function isSegment(piece: ActivitySegment | ThreadRenderableBlock): piece is ActivitySegment {
  return piece.kind === "reasoning" || piece.kind === "commands" || piece.kind === "files" || piece.kind === "webSearch";
}

function segmentItems(segment: ActivitySegment): ThreadItem[] {
  return segment.kind === "reasoning" ? [segment.item] : segment.items;
}

export function buildActivityRuns(blocks: readonly ThreadRenderableBlock[], context: CommandContext = {}): ThreadRenderableBlock[] {
  const result: ThreadRenderableBlock[] = [];
  let run: ActivityRunBlock | null = null;
  for (const piece of blocks.flatMap(block => toSegments(block, context))) {
    if (!isSegment(piece)) {
      run = null;
      result.push(piece);
      continue;
    }
    if (!run) {
      run = { items: [], kind: "activityRun", segments: [] };
      result.push(run);
    }
    if (!appendToPrevious(run.segments.at(-1), piece)) run.segments.push(copySegment(piece));
    run.items.push(...segmentItems(piece));
  }
  return result;
}

/** Adjacent commands share one group, adjacent file changes one list, adjacent searches one row; reasoning steps stay apart. */
function appendToPrevious(previous: ActivitySegment | undefined, piece: ActivitySegment) {
  if (previous?.kind === "commands" && piece.kind === "commands") previous.items.push(...piece.items);
  else if (previous?.kind === "files" && piece.kind === "files") previous.items.push(...piece.items);
  else if (previous?.kind === "webSearch" && piece.kind === "webSearch") previous.items.push(...piece.items);
  else return false;
  return true;
}

function copySegment(segment: ActivitySegment): ActivitySegment {
  switch (segment.kind) {
    case "reasoning": return segment;
    case "commands": return { items: [...segment.items], kind: "commands" };
    case "files": return { items: [...segment.items], kind: "files" };
    case "webSearch": return { items: [...segment.items], kind: "webSearch" };
  }
}
