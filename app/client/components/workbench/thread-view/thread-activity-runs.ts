/*
 * Exports:
 * - buildActivityRuns: fold consecutive reasoning, plain commands (Browse included), sleeps, file changes, web searches and
 *   code-mode executions into activity runs; screenshot steers a Browse step already shows fold away; every other block stays a boundary.
 * - RUN_SEGMENT_KINDS: every run step kind's merge, prose and tint rules, in one table.
 * - getSettledActivitySegments: a run's steps without the running ones, for its summary.
 * - getActivityRunPresentation: whether a run shows as a card or as its one step.
 * - getActivitySegmentItems: the items one run segment shows.
 * - pushActivitySegment: add one step to a segment list under the kind's merge rule.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getAgentScreenshotSteerImages, isAgentScreenshotSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-markers";
import { matchThreadGenericItem } from "../../../workbench/thread/thread-generic-item-matchers";
import { getNativeFileChanges } from "../../../workbench/thread/thread-command-matchers";
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
  return piece.kind === "hidden" || Object.hasOwn(RUN_SEGMENT_KINDS, piece.kind);
}

/**
 * Every run step kind in one place. `merges`: adjacent pieces of the kind share one segment (commands one group, file
 * changes one list, searches one row). `tinted`: the segment sits in a tinted group whose rows are steps. `prose`: it
 * reads like the agent's own words (reasoning, sleeps), so it gets breathing room where action groups sit tight.
 * A new kind adds its entry here and its renderer in the run.
 */
export const RUN_SEGMENT_KINDS: {
  readonly [Kind in ActivitySegment["kind"]]: { readonly merges: boolean; readonly prose: boolean; readonly tinted: boolean };
} = {
  code: { merges: false, prose: false, tinted: true },
  commands: { merges: true, prose: false, tinted: true },
  files: { merges: true, prose: false, tinted: false },
  reasoning: { merges: false, prose: true, tinted: false },
  sleep: { merges: false, prose: true, tinted: false },
  webSearch: { merges: true, prose: false, tinted: false },
};

function isRunning(item: ThreadItem) {
  return "status" in item && item.status === "inProgress";
}

/** The run's steps without the ones still running, for a summary that counts only what has happened. */
export function getSettledActivitySegments(segments: readonly ActivitySegment[]): ActivitySegment[] {
  return segments.flatMap((segment): ActivitySegment[] => {
    if (!("items" in segment)) return isRunning(segment.item) ? [] : [segment];
    const items = segment.items.filter(item => !isRunning(item));
    return items.length ? [{ ...segment, items } as ActivitySegment] : [];
  });
}

/** File operations on one path stitch into one row (a retried edit is one step), so files count by path. */
function countVisibleSteps(segments: readonly ActivitySegment[]) {
  return segments.reduce((count, segment) => count + (segment.kind === "files"
    ? new Set(segment.items.flatMap(item => item.type === "fileChange"
      ? item.changes.map(change => change.path)
      : getNativeFileChanges(item).map(({ change }) => change.path))).size
    : getActivitySegmentItems(segment).length), 0);
}

/**
 * A run is a card summarising several steps. Settled with one step it is just that step; a lone sleep is its own live
 * countdown, so it shows bare even while it runs.
 */
export function getActivityRunPresentation(segments: readonly ActivitySegment[], live: boolean): "bare" | "card" {
  if (countVisibleSteps(segments) !== 1) return "card";
  return !live || segments[0]?.kind === "sleep" ? "bare" : "card";
}

export function getActivitySegmentItems(segment: ActivitySegment): ThreadItem[] {
  return "items" in segment ? segment.items : [segment.item];
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
    pushActivitySegment(run.segments, piece);
    run.items.push(...getActivitySegmentItems(piece));
  }
  // A run holding only hidden members has nothing to show.
  return result.filter(block => block.kind !== "activityRun" || block.segments.length > 0);
}

type ListSegment = Extract<ActivitySegment, { items: readonly unknown[] }>;

/** Add one step, joining the last segment when its kind merges; the segments own their lists. */
export function pushActivitySegment(segments: ActivitySegment[], segment: ActivitySegment) {
  if (!appendToPrevious(segments.at(-1), segment)) segments.push(copySegment(segment));
}

function appendToPrevious(previous: ActivitySegment | undefined, piece: ActivitySegment) {
  if (!previous || previous.kind !== piece.kind || !RUN_SEGMENT_KINDS[piece.kind].merges || !("items" in previous) || !("items" in piece)) return false;
  // Same kind, so the item lists hold the same item type.
  (previous.items as ListSegment["items"][number][]).push(...piece.items);
  return true;
}

/** Runs own their segments' lists, so merging never mutates a block's. */
function copySegment(segment: ActivitySegment): ActivitySegment {
  return "items" in segment ? { ...segment, items: [...segment.items] } as ActivitySegment : segment;
}
