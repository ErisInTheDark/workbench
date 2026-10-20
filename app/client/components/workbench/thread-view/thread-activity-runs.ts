/*
 * Exports:
 * - buildActivityRuns: fold consecutive reasoning, plain commands (Browse included), sleeps, file changes, web searches and
 *   code-mode executions into activity runs; screenshot steers a Browse step already shows fold away; every other block stays a boundary.
 * - getActivitySegmentItems: the items one run segment shows.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getAgentScreenshotSteerImages, isAgentScreenshotSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-markers";
import { matchThreadGenericItem } from "../../../workbench/thread/thread-generic-item-matchers";
import {
  buildCommandSequenceRenderSegments,
  isRunStepSegment,
  type ActivitySegment,
  type ThreadRenderableBlock,
} from "./thread-render-blocks";

type ActivityRunBlock = Extract<ThreadRenderableBlock, { kind: "activityRun" }>;

type CommandContext = Omit<Parameters<typeof buildCommandSequenceRenderSegments>[0], "items"> & {
  /** Screenshots Browse steps already show; steers carrying only these are duplicates. */
  browseScreenshotUrls?: ReadonlySet<string>;
  /** Show code-mode executions as steps even when their calls already show as their own steps. */
  codeDetails?: boolean;
};

/** A run member that adds no visible step: a code-mode execution whose calls show as their own steps. */
interface HiddenMember { kind: "hidden"; item: ThreadItem }
type Piece = ActivitySegment | HiddenMember | ThreadRenderableBlock;

/**
 * Plain commands and run steps (arc reads, vis, recall, queue checks) join runs; lifecycle commands (arc changes,
 * subagents, titles, approvals) keep their own rows and end the run.
 */
function splitCommandBlock(block: Extract<ThreadRenderableBlock, { kind: "commandSequence" }>, context: CommandContext) {
  return buildCommandSequenceRenderSegments({ items: block.items, ...context }).map<Piece>(segment => {
    if (segment.kind === "commands") return { items: segment.items, kind: "commands" };
    if (isRunStepSegment(segment)) return { items: [segment.item], kind: "commands" };
    if (segment.kind === "sleep") return segment;
    if (segment.kind === "approval") return { items: segment.items, kind: "commandSequence" };
    if (segment.kind === "subagentWait") return { items: segment.group.entries.map(entry => entry.item), kind: "commandSequence" };
    return { items: [segment.item], kind: "commandSequence" };
  });
}

function isBrowseScreenshotDuplicate(block: ThreadRenderableBlock, urls: ReadonlySet<string> | undefined) {
  if (!urls?.size || block.kind !== "item" || block.item.type !== "userMessage" || !isAgentScreenshotSteerUserMessage(block.item)) return false;
  const images = getAgentScreenshotSteerImages(block.item);
  return images.length > 0 && images.every(image => urls.has(image.url));
}

/** OpenCode code mode runs JavaScript whose tool calls are recorded as their own items; the execution itself is a run step. */
function toCodeModePiece(block: Extract<ThreadRenderableBlock, { kind: "item" }>, context: CommandContext): Piece | null {
  const item = block.item;
  if (item.type !== "dynamicToolCall" || item.namespace !== "opencode" || item.tool !== "execute") return null;
  const failed = item.status === "failed" || item.success === false;
  return block.hasCapturedChildren && !failed && !context.codeDetails ? { item, kind: "hidden" } : { item, kind: "code" };
}

/** A provider's sleep item is the same run step as a sleep command. */
function toSleepPiece(block: Extract<ThreadRenderableBlock, { kind: "item" }>): Piece | null {
  if (block.item.type !== "generic") return null;
  const match = matchThreadGenericItem(block.item);
  return match?.kind === "sleep" ? { durationMs: match.durationMs, item: block.item, kind: "sleep" } : null;
}

function toPieces(block: ThreadRenderableBlock, context: CommandContext): Piece[] {
  switch (block.kind) {
    case "reasoningSequence": return block.items.map(item => ({ item, kind: "reasoning" as const }));
    case "fileChangeSequence": return [{ items: block.items, kind: "files" }];
    case "webSearchSequence": return [{ items: block.items, kind: "webSearch" }];
    case "commandSequence": return splitCommandBlock(block, context);
    case "item": return [toCodeModePiece(block, context) ?? toSleepPiece(block) ?? block];
    default: return [block];
  }
}

function isRunPiece(piece: Piece): piece is ActivitySegment | HiddenMember {
  return piece.kind === "reasoning" || piece.kind === "code" || piece.kind === "commands" || piece.kind === "files"
    || piece.kind === "sleep" || piece.kind === "webSearch" || piece.kind === "hidden";
}

export function getActivitySegmentItems(segment: ActivitySegment): ThreadItem[] {
  return segment.kind === "reasoning" || segment.kind === "code" || segment.kind === "sleep" ? [segment.item] : segment.items;
}

export function buildActivityRuns(blocks: readonly ThreadRenderableBlock[], context: CommandContext = {}): ThreadRenderableBlock[] {
  const result: ThreadRenderableBlock[] = [];
  let run: ActivityRunBlock | null = null;
  const visible = blocks.filter(block => !isBrowseScreenshotDuplicate(block, context.browseScreenshotUrls));
  for (const piece of visible.flatMap(block => toPieces(block, context))) {
    if (!isRunPiece(piece)) {
      run = null;
      result.push(piece);
      continue;
    }
    if (!run) {
      run = { items: [], kind: "activityRun", segments: [] };
      result.push(run);
    }
    if (piece.kind === "hidden") {
      run.items.push(piece.item);
      continue;
    }
    if (!appendToPrevious(run.segments.at(-1), piece)) run.segments.push(copySegment(piece));
    run.items.push(...getActivitySegmentItems(piece));
  }
  // A run holding only hidden members has nothing to show.
  return result.filter(block => block.kind !== "activityRun" || block.segments.length > 0);
}

/** Adjacent commands share one group, adjacent file changes one list, adjacent searches one row; reasoning and code steps stay apart. */
function appendToPrevious(previous: ActivitySegment | undefined, piece: ActivitySegment) {
  if (previous?.kind === "commands" && piece.kind === "commands") previous.items.push(...piece.items);
  else if (previous?.kind === "files" && piece.kind === "files") previous.items.push(...piece.items);
  else if (previous?.kind === "webSearch" && piece.kind === "webSearch") previous.items.push(...piece.items);
  else return false;
  return true;
}

function copySegment(segment: ActivitySegment): ActivitySegment {
  switch (segment.kind) {
    case "reasoning":
    case "code":
    case "sleep": return segment;
    case "commands": return { items: [...segment.items], kind: "commands" };
    case "files": return { items: [...segment.items], kind: "files" };
    case "webSearch": return { items: [...segment.items], kind: "webSearch" };
  }
}
