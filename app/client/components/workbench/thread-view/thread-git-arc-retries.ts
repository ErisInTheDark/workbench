/*
 * Exports:
 * - foldGitArcHistories: fold failed arc starts, waits or continues (with the work between) into the start that finally
 *   succeeded, then fold the arc-only review steps leading into a completed proposal into it.
 * - isGitArcCall: a block that is one Git arc call, drawn as one Git arc card.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { readGitArcMcpResult } from "workbench-shared/workbench/git/git-arc-mcp-result";
import {
  getGitArcMatcherAction, getThreadCommandDisplay, getThreadCommandExecutionOutcome, getThreadMcpToolCallOutcome,
  getWorkbenchMcpCommandRoute, isGitArcWaitMatcherClaim, type GitArcCommandAction,
} from "../../../workbench/thread/thread-command-matchers";
import { buildCardHistory } from "./thread-activity-runs";
import {
  getRenderableBlockItems, type CommandItem, type CommandSequenceItem, type ThreadRenderableBlock,
} from "./thread-render-blocks";

type ActivityRunBlock = Extract<ThreadRenderableBlock, { kind: "activityRun" }>;
/** A wait starts its plan once sibling claims clear, so it is a start attempt too. */
type ArcCallAction = GitArcCommandAction | "wait";
type ArcCall = { action: ArcCallAction; item: CommandSequenceItem; outcome: "completed" | "failed" | "other" };

const STARTS: ReadonlySet<ArcCallAction> = new Set(["start", "planStart", "wait"]);
/** Reads an agent makes while working out why its start failed; they change nothing, so they fold into the retry. */
const READS: ReadonlySet<ArcCallAction> = new Set(["status", "scope"]);

/** One Git arc call; an interrupted or running call has no settled outcome. */
function readArcItem(item: ThreadItem): ArcCall | null {
  if (item.type === "mcpToolCall") {
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
    if (route?.kind !== "specialized" || (route.operation.kind !== "gitArc" && route.operation.kind !== "gitArcWait")) return null;
    const typed = readGitArcMcpResult(item.result?.structuredContent ?? null);
    const result = typed?.kind === "valid" ? typed.result : null;
    const base = getThreadMcpToolCallOutcome(item);
    const outcome = result?.kind === "interruptedBySteer" || base === "inProgress" ? "other"
      : result?.kind === "failure" || typed?.kind === "invalid" || base === "failed" ? "failed" : "completed";
    return { action: route.operation.kind === "gitArcWait" ? "wait" : route.operation.operation.action, item, outcome };
  }
  if (item.type !== "commandExecution") return null;
  // Every command item can carry the shell it ran in; plain canonical items simply have none.
  const { shell }: CommandItem = item;
  const display = getThreadCommandDisplay({ command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell });
  const action = isGitArcWaitMatcherClaim(display.claimedBy) ? "wait" : getGitArcMatcherAction(display.claimedBy);
  if (!action) return null;
  const outcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
  return { action, item, outcome: outcome === "completed" ? "completed" : outcome === "failed" || outcome === "timedOut" ? "failed" : "other" };
}

/** One Git arc call standing alone as a block. */
function readArcCall(block: ThreadRenderableBlock): ArcCall | null {
  if (block.kind === "item") return block.item.type === "mcpToolCall" ? readArcItem(block.item) : null;
  return block.kind === "commandSequence" && block.items.length === 1 ? readArcItem(block.items[0]!) : null;
}

function readGitArcStartAttempt(block: ThreadRenderableBlock) {
  const call = readArcCall(block);
  return call && STARTS.has(call.action) ? call : null;
}

function isFailedStart(block: ThreadRenderableBlock) {
  return readGitArcStartAttempt(block)?.outcome === "failed";
}

/** A failed start, wait or continue; continues are run steps, so they sit inside activity runs. */
function isFailedAttempt(item: ThreadItem) {
  const call = readArcItem(item);
  return Boolean(call && call.outcome === "failed" && (STARTS.has(call.action) || call.action === "continue"));
}

/** Split a run at its first failed continue: the work before it, and the run from the continue on. */
function splitAtFailedContinue(run: ActivityRunBlock): { head: ActivityRunBlock | null; tail: ActivityRunBlock } | null {
  const segmentIndex = run.segments.findIndex(segment => segment.kind === "commands"
    && segment.items.some(item => readArcItem(item)?.action === "continue" && isFailedAttempt(item)));
  const segment = run.segments[segmentIndex];
  if (segment?.kind !== "commands") return null;
  const at = segment.items.findIndex(item => readArcItem(item)?.action === "continue" && isFailedAttempt(item));
  const itemIndex = run.items.indexOf(segment.items[at]!);
  const headSegments = [...run.segments.slice(0, segmentIndex), ...(at ? [{ ...segment, items: segment.items.slice(0, at) }] : [])];
  return {
    head: headSegments.length ? { items: run.items.slice(0, itemIndex), kind: "activityRun", segments: headSegments } : null,
    tail: {
      items: run.items.slice(itemIndex),
      kind: "activityRun",
      segments: [{ ...segment, items: segment.items.slice(at) }, ...run.segments.slice(segmentIndex + 1)],
    },
  };
}

/** What may sit between a failed start and its retry: runs of work, arc reads and further failed starts. */
function isAbsorbable(block: ThreadRenderableBlock) {
  if (block.kind === "activityRun" || isFailedStart(block)) return true;
  const call = readArcCall(block);
  return Boolean(call && READS.has(call.action) && call.outcome !== "other");
}

/** The card `success` opening onto `span` (runs and absorbable arc calls) as run steps. */
function historyBlock(span: readonly ThreadRenderableBlock[], success: ThreadRenderableBlock): ThreadRenderableBlock {
  const failedAttempts = span.flatMap(entry => getRenderableBlockItems(entry)).filter(isFailedAttempt).length;
  return buildCardHistory(span.map(entry => entry.kind === "activityRun" ? entry : readArcCall(entry)!.item), success, failedAttempts);
}

/**
 * Only a completed retry folds: until then every attempt and step stays its own row. Messages, steers, the agent's
 * commentary and any other card end the span, so nothing said to the user hides inside a closed card.
 */
function foldRetries(blocks: readonly ThreadRenderableBlock[]): ThreadRenderableBlock[] {
  const folded: ThreadRenderableBlock[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index]!;
    const split = block.kind === "activityRun" ? splitAtFailedContinue(block) : null;
    if (!isFailedStart(block) && !split) {
      folded.push(block);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < blocks.length && isAbsorbable(blocks[end]!)) end += 1;
    const success = blocks[end];
    if (!success || readGitArcStartAttempt(success)?.outcome !== "completed") {
      folded.push(...blocks.slice(index, end));
      index = end;
      continue;
    }
    if (split?.head) folded.push(split.head);
    folded.push(historyBlock([split?.tail ?? block, ...blocks.slice(index + 1, end)], success));
    index = end + 1;
  }
  return folded;
}

/** A run of nothing but arc review calls (compare, diff, claims...) leading into a proposal; an edit session is work. */
function isArcOnlyRun(block: ThreadRenderableBlock) {
  return block.kind === "activityRun" && block.items.every(item => {
    const action = readArcItem(item)?.action;
    return action !== undefined && action !== "edit";
  });
}

/** A completed proposal opens onto the arc-only run right before it; anything else in that run keeps both apart. */
function foldLeadIns(blocks: readonly ThreadRenderableBlock[]): ThreadRenderableBlock[] {
  const folded: ThreadRenderableBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const next = blocks[index + 1];
    const proposal = next ? readArcCall(next) : null;
    if (next && isArcOnlyRun(block) && proposal?.action === "propose" && proposal.outcome === "completed") {
      folded.push(historyBlock([block], next));
      index += 1;
      continue;
    }
    folded.push(block);
  }
  return folded;
}

/** A block that is one Git arc call, drawn as one Git arc card. */
export function isGitArcCall(block: ThreadRenderableBlock) {
  return readArcCall(block) !== null;
}

/** Fold retried starts, then proposals' lead-in steps, into their cards. */
export function foldGitArcHistories(blocks: readonly ThreadRenderableBlock[]): ThreadRenderableBlock[] {
  return foldLeadIns(foldRetries(blocks));
}
