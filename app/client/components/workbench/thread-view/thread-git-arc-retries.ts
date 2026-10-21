/*
 * Exports:
 * - readGitArcStartAttempt: a block that is one Git arc start (plain start, plan start or wait, MCP or CLI) and how it ended.
 * - foldGitArcRetries: fold failed arc starts or waits, the work between them and the start that finally succeeded into one block.
 */
import { readGitArcMcpResult } from "workbench-shared/workbench/git/git-arc-mcp-result";
import {
  getGitArcMatcherAction, getThreadCommandDisplay, getThreadCommandExecutionOutcome, getThreadMcpToolCallOutcome,
  getWorkbenchMcpCommandRoute, isGitArcWaitMatcherClaim, type GitArcCommandAction,
} from "../../../workbench/thread/thread-command-matchers";
import { pushActivitySegment } from "./thread-activity-runs";
import {
  getRenderableBlockItems, type ActivitySegment, type CommandSequenceItem, type ThreadRenderableBlock,
} from "./thread-render-blocks";

/** A wait starts its plan once sibling claims clear, so it is a start attempt too. */
type ArcCallAction = GitArcCommandAction | "wait";
type ArcCall = { action: ArcCallAction; item: CommandSequenceItem; outcome: "completed" | "failed" | "other" };

const STARTS: ReadonlySet<ArcCallAction> = new Set(["start", "planStart", "wait"]);
/** Reads an agent makes while working out why its start failed; they change nothing, so they fold into the retry. */
const READS: ReadonlySet<ArcCallAction> = new Set(["status", "scope"]);

/** One Git arc call standing alone as a block; an interrupted or running call has no settled outcome. */
function readArcCall(block: ThreadRenderableBlock): ArcCall | null {
  if (block.kind === "item" && block.item.type === "mcpToolCall") {
    const item = block.item;
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
    if (route?.kind !== "specialized" || (route.operation.kind !== "gitArc" && route.operation.kind !== "gitArcWait")) return null;
    const typed = readGitArcMcpResult(item.result?.structuredContent ?? null);
    const result = typed?.kind === "valid" ? typed.result : null;
    const base = getThreadMcpToolCallOutcome(item);
    const outcome = result?.kind === "interruptedBySteer" || base === "inProgress" ? "other"
      : result?.kind === "failure" || typed?.kind === "invalid" || base === "failed" ? "failed" : "completed";
    return { action: route.operation.kind === "gitArcWait" ? "wait" : route.operation.operation.action, item, outcome };
  }
  if (block.kind !== "commandSequence" || block.items.length !== 1) return null;
  const item = block.items[0]!;
  if (item.type !== "commandExecution") return null;
  const display = getThreadCommandDisplay({ command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell: item.shell });
  const action = isGitArcWaitMatcherClaim(display.claimedBy) ? "wait" : getGitArcMatcherAction(display.claimedBy);
  if (!action) return null;
  const outcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
  return { action, item, outcome: outcome === "completed" ? "completed" : outcome === "failed" || outcome === "timedOut" ? "failed" : "other" };
}

export function readGitArcStartAttempt(block: ThreadRenderableBlock) {
  const call = readArcCall(block);
  return call && STARTS.has(call.action) ? call : null;
}

function isFailedStart(block: ThreadRenderableBlock) {
  return readGitArcStartAttempt(block)?.outcome === "failed";
}

/** What may sit between a failed start and its retry: runs of work, arc reads and further failed starts. */
function isAbsorbable(block: ThreadRenderableBlock) {
  if (block.kind === "activityRun" || isFailedStart(block)) return true;
  const call = readArcCall(block);
  return Boolean(call && READS.has(call.action) && call.outcome !== "other");
}

/**
 * Only a completed retry folds: until then every attempt and step stays its own row. Messages, steers, the agent's
 * commentary and any other card end the span, so nothing said to the user hides inside a closed card.
 */
export function foldGitArcRetries(blocks: readonly ThreadRenderableBlock[]): ThreadRenderableBlock[] {
  const folded: ThreadRenderableBlock[] = [];
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index]!;
    if (!isFailedStart(block)) {
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
    const history: ActivitySegment[] = [];
    let failedAttempts = 0;
    for (const absorbed of blocks.slice(index, end)) {
      if (absorbed.kind === "activityRun") {
        for (const segment of absorbed.segments) pushActivitySegment(history, segment);
        continue;
      }
      if (isFailedStart(absorbed)) failedAttempts += 1;
      pushActivitySegment(history, { items: [readArcCall(absorbed)!.item], kind: "commands" });
    }
    folded.push({
      failedAttempts,
      history,
      items: blocks.slice(index, end + 1).flatMap(entry => getRenderableBlockItems(entry)),
      kind: "gitArcRetry",
      success,
    });
    index = end + 1;
  }
  return folded;
}
