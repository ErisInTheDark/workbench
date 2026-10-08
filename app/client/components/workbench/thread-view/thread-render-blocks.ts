/*
 * Exports:
 * - CommandItem/CommandSequenceItem/ThreadRenderableBlock/HiddenThreadItemIds: shared render-plan shapes.
 * - IncomingAgentMessageItem: an attributed cross-agent message item.
 * - AgentCommentaryItem: a non-final agent message grouped into a commentary sequence block.
 * - buildRenderableBlocks: group visible provider items, preserve wait folds, then give qualifying subagent coordination one outer render block.
 * - SubagentWaitItem: a settled subagent wait as a CLI command or wb MCP call.
 * - IncomingAgentMessageRun/groupIncomingAgentMessageRuns: bundle every same-sender, same-state incoming message in a group into one bubble.
 * - getUserMessageDeliveryState: classify held (pending or undelivered) user-message input.
 * - isHiddenCommandExecution/hasReasoningSteps: shared visibility decisions.
 * - CommandSequenceRenderSegment/buildCommandSequenceRenderSegments: final command presentation groups.
 * - isBrowseCommandItem: identify commands rendered separately as Browse requests.
 * - getWorkedBlockRows: split independently rendered work rows and identify protected content.
 * - getRenderableBlockItems/getRenderableBlockKey: identify grouped render rows.
 * - reuseRenderableBlocks/hasSameBlockTimeline: retain unchanged rows across SQL item arrivals.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { findWorkbenchThreadItemTimelineEntry, type WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import type { WorkbenchSkillSummary } from "workbench-shared/types";
import { isWorkbenchActivatedSkillsInput } from "workbench-shared/workbench/thread/thread-activated-skills";
import {
  readWorkbenchAgentMessageInput, readWorkbenchAgentMessageItem, type WorkbenchAgentMessage,
} from "workbench-shared/workbench/thread/thread-agent-message";
import { isWorkbenchPendingSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-history";
import { getWorkbenchInputState, type WorkbenchInputState } from "workbench-shared/workbench/thread/thread-input-item";
import { getWorkbenchThreadItemIdentityKind } from "workbench-shared/workbench/thread/thread-item-identity";
import {
  isVisibleWorkbenchAgentMessageText, isWorkbenchHiddenSystemSteerInput,
} from "workbench-shared/workbench/thread/thread-recovery-message";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";
import { isAgentScreenshotSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-markers";
import { readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import {
  getThreadCommandDisplay, getThreadCommandExecutionOutcome, getThreadSubagentWaitMcpOutcome, getGitArcMatcherAction,
  getNativeToolDisplay,
  getWorkbenchMcpCommandRoute, getWorkbenchMcpShellCommandItem,
  isNativeFileOperation, getNativeFileChanges,
  isBrowseCommandMatcherClaim, isThreadContextMatcherClaim,
  isWorkbenchTaskStatusMatcherClaim, isWorkbenchTaskTitleSetMatcherClaim,
  parseWorkbenchMessageCommand, parseWorkbenchSubagentCommand, parseWorkbenchTaskStatusCommand, parseWorkbenchTaskTitleCommand, parseWorkbenchThreadRecallCommand,
  type CommandShell,
  type ThreadCommandExecutionOutcome,
  type WorkbenchThreadRecallOperation,
} from "../../../workbench/thread/thread-command-matchers";
import type { WorkbenchSubagentCommandTarget } from "../../../workbench/thread/command-matchers/workbench-cli";
import { getWorkbenchSubagentCommandTargetKey } from "../../../workbench/thread/thread-subagents";
import { omitThreadReasoningStep, type ThreadReasoningStepReference } from "./thread-reasoning-display";
import { isThreadWebSearchPlaceholder } from "./thread-web-search-state";
import {
  findThreadSubagentWaitExchanges, groupThreadSubagentWaitRenderEntries,
  type ThreadSubagentWaitExchangeRole, type ThreadSubagentWaitRenderEntry, type ThreadSubagentWaitRenderGroup,
} from "./thread-subagent-wait-groups";
import {
  findThreadSubagentCoordinationSpans,
  readThreadSubagentCoordinationClaimAction,
  readThreadSubagentCoordinationOutgoingMessage,
  readThreadSubagentCoordinationWait,
  type ThreadSubagentCoordinationRole,
} from "./thread-subagent-coordination";
import { formatToolCallOutput } from "./format-thread-tool-call";

const TASK_TITLE_ALREADY_MATCHES_OUTPUT = "Task title already matches";

/** `workbenchShell` marks a command derived from a wb shell call, which Workbench owns and the user can stop. */
export type CommandItem = Extract<ThreadItem, { type: "commandExecution" }> & { shell?: CommandShell; workbenchShell?: true };
export type CommandSequenceItem = CommandItem | Extract<ThreadItem, { type: "mcpToolCall" | "dynamicToolCall" }>;
type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;
export type IncomingAgentMessageItem = UserMessageItem | Extract<ThreadItem, { type: "functionCallOutput" }>;
/** A settled subagent wait, as a CLI command or a wb MCP call. */
export type SubagentWaitItem = CommandItem | Extract<ThreadItem, { type: "mcpToolCall" }>;
export interface IncomingAgentMessageRun {
  deliveryState: ReturnType<typeof getUserMessageDeliveryState>;
  items: IncomingAgentMessageItem[];
  messages: [WorkbenchAgentMessage, ...WorkbenchAgentMessage[]];
}
export type AgentCommentaryItem = Extract<ThreadItem, { type: "agentMessage" }>;
export type ThreadRenderableBlock =
  | { kind: "agentMessageSequence"; items: IncomingAgentMessageItem[]; state: "delivered" | "held" }
  /** Consecutive non-final agent messages, which share copy runs. */
  | { kind: "agentCommentarySequence"; items: AgentCommentaryItem[] }
  | {
    /** Existing render blocks absorbed by the priority two-way coordination disclosure. */
    blocks: ThreadRenderableBlock[];
    items: ThreadItem[];
    kind: "subagentCoordination";
  }
  | {
    /** Chronological waits and messages, which render as one wait row then one message group. */
    items: Array<SubagentWaitItem | IncomingAgentMessageItem>;
    kind: "subagentWaitExchange";
    messages: IncomingAgentMessageItem[];
    outcome: ThreadCommandExecutionOutcome;
    /** Every waited-for target, first-seen order. */
    targets: WorkbenchSubagentCommandTarget[];
    waits: SubagentWaitItem[];
  }
  | { kind: "commandSequence"; items: CommandSequenceItem[] }
  | { kind: "fileChangeSequence"; items: Extract<ThreadItem, { type: "fileChange" | "dynamicToolCall" | "mcpToolCall" }>[] }
  | { kind: "reasoningSequence"; items: Extract<ThreadItem, { type: "reasoning" }>[] }
  | { kind: "userMessageSequence"; items: UserMessageItem[]; state: WorkbenchInputState["status"] }
  | { kind: "webSearchSequence"; items: Extract<ThreadItem, { type: "webSearch" }>[] }
  | { kind: "item"; hasCapturedChildren?: boolean; item: Exclude<ThreadItem, { type: "commandExecution" | "fileChange" | "reasoning" }> };

export interface HiddenThreadItemIds {
  controlAgentMessages?: boolean;
  controlUserMessages?: boolean;
  dynamicToolCallIds?: ReadonlySet<string> | null;
  itemIds?: ReadonlySet<string> | null;
  reasoningStep?: ThreadReasoningStepReference | null;
  webSearchItemIds?: ReadonlySet<string> | null;
}

export function getRenderableBlockItems(block: ThreadRenderableBlock): readonly ThreadItem[] {
  return block.kind === "item" ? [block.item] : block.items;
}

export function getRenderableBlockKey(block: ThreadRenderableBlock) {
  return [block.kind, ...getRenderableBlockItems(block).map(item => item.id)].join(":");
}

export function reuseRenderableBlocks(
  previous: readonly ThreadRenderableBlock[],
  next: readonly ThreadRenderableBlock[],
): ThreadRenderableBlock[] {
  const previousByKey = new Map(previous.map(block => [getRenderableBlockKey(block), block]));
  return next.map(block => {
    const old = previousByKey.get(getRenderableBlockKey(block));
    if (!old || old.kind !== block.kind) return block;
    if (old.kind === "item" && block.kind === "item") {
      return old.item === block.item && old.hasCapturedChildren === block.hasCapturedChildren ? old : block;
    }
    const oldItems = getRenderableBlockItems(old);
    const nextItems = getRenderableBlockItems(block);
    return oldItems.length === nextItems.length
      && oldItems.every((item, index) => item === nextItems[index])
      && (!("state" in old) || !("state" in block) || old.state === block.state)
      ? old : block;
  });
}

export function hasSameBlockTimeline(
  block: ThreadRenderableBlock,
  left: readonly WorkbenchThreadItemTimelineEntry[] | null | undefined,
  right: readonly WorkbenchThreadItemTimelineEntry[] | null | undefined,
) {
  if (left === right) return true;
  return getRenderableBlockItems(block).every(item => {
    const before = findWorkbenchThreadItemTimelineEntry(item.id, left);
    const after = findWorkbenchThreadItemTimelineEntry(item.id, right);
    return before === after || areDeeplyEqual(before, after);
  });
}

export function isHiddenCommandExecution(command: string) {
  if (/^report_intent(?:\s|$)/i.test(command.trim())) return true;
  const display = getThreadCommandDisplay({ command, commandActions: [], cwd: "" });
  const dedicated = getGitArcMatcherAction(display.claimedBy)
    || isThreadContextMatcherClaim(display.claimedBy)
    || isWorkbenchTaskStatusMatcherClaim(display.claimedBy)
    || isWorkbenchTaskTitleSetMatcherClaim(display.claimedBy)
    || display.claimedBy?.split(",").includes("workbench-cli.subagent");
  return display.omitFromDisplay && !dedicated;
}

export function hasReasoningSteps(item: Extract<ThreadItem, { type: "reasoning" }>) {
  return item.summary.some(section => section.trim()) || item.content.some(section => section.trim());
}

/**
 * A provider-native tool call whose display is the shared command-summary grammar, so it groups with commands.
 * File operations own the file-change sequence, and the opencode execute wrapper owns captured children.
 */
function isNativeCommandToolCall(item: Extract<ThreadItem, { type: "dynamicToolCall" }>): boolean {
  return !isNativeFileOperation(item) && !(item.namespace === "opencode" && item.tool === "execute")
    && getNativeToolDisplay(item) !== null;
}

function isAlreadyMatchingTaskTitle(item: ThreadItem, fallbackCwd: string) {
  if (item.type === "commandExecution") {
    if (getThreadCommandExecutionOutcome(item.status, item.exitCode) !== "completed"
      || item.aggregatedOutput?.trim() !== TASK_TITLE_ALREADY_MATCHES_OUTPUT) return false;
    const display = getThreadCommandDisplay({
      command: item.command,
      commandActions: item.commandActions,
      cwd: item.cwd || fallbackCwd,
    });
    return isWorkbenchTaskTitleSetMatcherClaim(display.claimedBy);
  }
  if (item.type !== "mcpToolCall" || item.status !== "completed" || item.error
    || formatToolCallOutput({
      content: item.result?.content,
      fallback: item.result?.structuredContent ?? item.result?._meta,
    }).trim() !== TASK_TITLE_ALREADY_MATCHES_OUTPUT) return false;
  const route = getWorkbenchMcpCommandRoute({
    argumentsValue: item.arguments,
    server: item.server,
    tool: item.tool,
  });
  return route?.kind === "specialized" && route.operation.kind === "threadTitle";
}

/** Held input awaiting delivery (`pending`) or never delivered (`unsent`); null once delivered or for ordinary input. */
export function getUserMessageDeliveryState(item: UserMessageItem): "pending" | "unsent" | null {
  if (isWorkbenchPendingSteerUserMessage(item)) return "pending";
  const input = getWorkbenchInputState(item);
  if (
    (input?.kind === "steer" || (input?.kind === "optimistic" && input.placement === "steer"))
    && (input.status === "interrupted" || input.status === "failed")
  ) {
    return "unsent";
  }
  return null;
}

function readIncomingAgentMessageItem(item: ThreadItem): IncomingAgentMessageItem | null {
  return (item.type === "userMessage" || item.type === "functionCallOutput") && readWorkbenchAgentMessageItem(item) ? item : null;
}

function isHeldUserSteerBlock(block: ThreadRenderableBlock) {
  return (block.kind === "item" || block.kind === "userMessageSequence")
    && getRenderableBlockItems(block).some(item => item.type === "userMessage" && getUserMessageDeliveryState(item) !== null);
}

function getMergeableSteerState(item: UserMessageItem) {
  const input = getWorkbenchInputState(item);
  const isSteer = input?.kind === "steer"
    || (input?.kind === "optimistic" && input.placement === "steer");
  if (!isSteer
    || readWorkbenchAgentMessageInput(item.content)
    || isAgentScreenshotSteerUserMessage(item)) {
    return null;
  }

  const displayContent = unwrapWorkbenchSteerDisplayInput(item.content);
  return displayContent.length > 0
    && displayContent.every((part) => part.type === "text" && part.text_elements.length === 0)
    ? input.status
    : null;
}

/**
 * Each sender is its own channel within a group, so all of one sender's messages in one delivery state share a
 * bubble even when another sender's messages fall between them. Bubbles follow each sender's first message.
 */
export function groupIncomingAgentMessageRuns(items: readonly IncomingAgentMessageItem[]): IncomingAgentMessageRun[] {
  const runs = new Map<string, IncomingAgentMessageRun>();
  for (const item of items) {
    const message = readWorkbenchAgentMessageItem(item);
    if (!message) continue;
    const deliveryState = item.type === "userMessage" ? getUserMessageDeliveryState(item) : null;
    const key = `${deliveryState ?? "delivered"}\0${message.senderThreadId}`;
    const run = runs.get(key);
    if (run) {
      run.items.push(item);
      run.messages.push(message);
    } else {
      runs.set(key, { deliveryState, items: [item], messages: [message] });
    }
  }
  return [...runs.values()];
}

/** A block that is nothing but settled subagent waits, with what it waited for and how the last one ended. */
function readSettledSubagentWaits(block: ThreadRenderableBlock) {
  if (block.kind === "item" && block.item.type === "mcpToolCall") {
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: block.item.arguments, server: block.item.server, tool: block.item.tool });
    if (route?.kind !== "specialized" || route.operation.kind !== "subagent") return null;
    const operation = route.operation.operation;
    const outcome = getThreadSubagentWaitMcpOutcome(block.item);
    return operation.action === "wait" && operation.targets.length && outcome !== "inProgress"
      ? { items: [block.item] as SubagentWaitItem[], outcome, targets: operation.targets } : null;
  }
  if (block.kind !== "commandSequence" || !block.items.length) return null;
  const items: SubagentWaitItem[] = [];
  const targets: WorkbenchSubagentCommandTarget[] = [];
  let outcome: ThreadCommandExecutionOutcome = "completed";
  for (const item of block.items) {
    if (item.type !== "commandExecution") return null;
    const display = getThreadCommandDisplay({ command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell: item.shell });
    const command = parseWorkbenchSubagentCommand(display.unwrappedCommand, item.commandActions);
    outcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
    if (command?.action !== "wait" || !command.targets.length || outcome === "inProgress") return null;
    items.push(item);
    targets.push(...command.targets);
  }
  return { items, outcome, targets };
}

/** Settled waits ping-ponging with delivered messages read as one wait row and one message group. */
function foldSubagentWaitExchanges(blocks: ThreadRenderableBlock[]): ThreadRenderableBlock[] {
  const waits = blocks.map(readSettledSubagentWaits);
  const roles = blocks.map<ThreadSubagentWaitExchangeRole>((block, index) => waits[index] ? "wait"
    : block.kind === "agentMessageSequence" && block.state === "delivered" ? "messages" : "other");
  const spans = findThreadSubagentWaitExchanges(roles);
  if (!spans.length) return blocks;
  const folded: ThreadRenderableBlock[] = [];
  let cursor = 0;
  for (const { end, start } of spans) {
    folded.push(...blocks.slice(cursor, start));
    const exchange: Extract<ThreadRenderableBlock, { kind: "subagentWaitExchange" }> = {
      items: [], kind: "subagentWaitExchange", messages: [], outcome: "completed", targets: [], waits: [],
    };
    const targetKeys = new Set<string>();
    for (let index = start; index < end; index += 1) {
      const block = blocks[index]!;
      const wait = waits[index];
      if (wait) {
        exchange.waits.push(...wait.items);
        exchange.items.push(...wait.items);
        exchange.outcome = wait.outcome;
        for (const target of wait.targets) {
          const key = getWorkbenchSubagentCommandTargetKey(target);
          if (!targetKeys.has(key)) { targetKeys.add(key); exchange.targets.push(target); }
        }
      } else if (block.kind === "agentMessageSequence") {
        exchange.messages.push(...block.items);
        exchange.items.push(...block.items);
      }
    }
    folded.push(exchange);
    cursor = end;
  }
  folded.push(...blocks.slice(cursor));
  return folded;
}

function splitCoordinationCommandSequence(
  block: Extract<ThreadRenderableBlock, { kind: "commandSequence" }>,
): ThreadRenderableBlock[] {
  const segments = buildCommandSequenceRenderSegments({ items: block.items });
  if (!segments.some(segment => segment.kind === "message"
    || segment.kind === "subagentWait"
    || segment.kind === "gitArc" && readThreadSubagentCoordinationClaimAction(segment.item))) return [block];
  return segments.map(segment => {
    if (segment.kind === "approval" || segment.kind === "commands") {
      return { items: segment.items, kind: "commandSequence" };
    }
    if (segment.kind === "subagentWait") {
      return { items: segment.group.entries.map(entry => entry.item), kind: "commandSequence" };
    }
    return { items: [segment.item], kind: "commandSequence" };
  });
}

function getCoordinationBlockRole(block: ThreadRenderableBlock): ThreadSubagentCoordinationRole | null {
  if (block.kind === "agentMessageSequence") {
    return block.state === "delivered" ? { incoming: true, itemCount: block.items.length, outgoing: false } : null;
  }
  if (block.kind === "subagentWaitExchange") {
    return { incoming: block.messages.length > 0, itemCount: block.items.length, outgoing: false };
  }
  if (block.kind === "commandSequence" && block.items.length) {
    const segments = buildCommandSequenceRenderSegments({ items: block.items });
    if (segments.length !== 1) return null;
    const [segment] = segments;
    if (segment?.kind === "message") return readThreadSubagentCoordinationOutgoingMessage(segment.item)
      ? { incoming: false, itemCount: 1, outgoing: true }
      : null;
    if (segment?.kind === "subagentWait") return {
      incoming: false,
      itemCount: segment.group.entries.length,
      outgoing: false,
    };
    if (segment?.kind === "gitArc") return readThreadSubagentCoordinationClaimAction(segment.item)
      ? { incoming: false, itemCount: 1, outgoing: false }
      : null;
    return null;
  }
  if (block.kind !== "item") return null;
  if (readThreadSubagentCoordinationOutgoingMessage(block.item)) return { incoming: false, itemCount: 1, outgoing: true };
  if (readThreadSubagentCoordinationClaimAction(block.item)) return { incoming: false, itemCount: 1, outgoing: false };
  return readThreadSubagentCoordinationWait(block.item)
    ? { incoming: false, itemCount: 1, outgoing: false }
    : null;
}

function coalesceCommandSequences(blocks: ThreadRenderableBlock[]) {
  const coalesced: ThreadRenderableBlock[] = [];
  for (const block of blocks) {
    const previous = coalesced.at(-1);
    if (previous?.kind === "commandSequence" && block.kind === "commandSequence") {
      coalesced[coalesced.length - 1] = {
        items: [...previous.items, ...block.items],
        kind: "commandSequence",
      };
    } else {
      coalesced.push(block);
    }
  }
  return coalesced;
}

/** Preserve existing folds, then replace qualifying activity with one higher-priority coordination block. */
function foldSubagentCoordination(blocks: ThreadRenderableBlock[]): ThreadRenderableBlock[] {
  const expanded = blocks.flatMap(block => block.kind === "commandSequence"
    ? splitCoordinationCommandSequence(block)
    : [block]);
  const spans = findThreadSubagentCoordinationSpans(expanded.map(getCoordinationBlockRole));
  if (!spans.length) return blocks;
  const folded: ThreadRenderableBlock[] = [];
  let cursor = 0;
  for (const { end, start } of spans) {
    folded.push(...expanded.slice(cursor, start));
    const coordinationBlocks = expanded.slice(start, end);
    folded.push({
      blocks: coordinationBlocks,
      items: coordinationBlocks.flatMap(block => getRenderableBlockItems(block)),
      kind: "subagentCoordination",
    });
    cursor = end;
  }
  folded.push(...expanded.slice(cursor));
  return coalesceCommandSequences(folded);
}

export function buildRenderableBlocks(items: ThreadItem[], hidden: HiddenThreadItemIds = {}, fallbackCwd = "."): ThreadRenderableBlock[] {
  const blocks: ThreadRenderableBlock[] = [];
  const capturedGroups = new Set(items.flatMap(item =>
    item.type === "mcpToolCall" && item.server === "wb" && item.toolCallGroupId ? [item.toolCallGroupId] : []));
  const rolloverGroups = new Set(items.flatMap(item =>
    item.type === "mcpToolCall" && item.server === "wb" && item.tool === "thread_compact" && item.toolCallGroupId
      ? [item.toolCallGroupId] : []));
  let pending: Extract<ThreadRenderableBlock, { kind: "commandSequence" | "fileChangeSequence" | "reasoningSequence" | "webSearchSequence" }> | null = null;
  const flush = () => { if (pending) blocks.push(pending); pending = null; };
  const commands = (item: CommandSequenceItem) => {
    if (pending?.kind !== "commandSequence") { flush(); pending = { kind: "commandSequence", items: [] }; }
    pending.items.push(item);
  };
  const narrativeKeys = new Set<string>();
  const heldAgentMessages: IncomingAgentMessageItem[] = [];
  let compacted = false;
  for (const item of items) {
    if (item.type === "plan") continue;
    if (hidden.itemIds?.has(item.id)) continue;
    if (isAlreadyMatchingTaskTitle(item, fallbackCwd)) continue;
    if (item.type === "userMessage" && (isWorkbenchHiddenSystemSteerInput(item.content)
      || (item.content.length > 0 && item.content.every(isWorkbenchActivatedSkillsInput)))) continue;
    const text = item.type === "agentMessage" ? item.text
      : item.type === "reasoning" ? [...item.summary, ...item.content].join("\n") : null;
    const normalized = text?.replace(/\s+/gu, " ").replace(/[^\p{L}\p{N}\s#`./:-]+/gu, "").trim().toLowerCase();
    const key = normalized && normalized.length >= 40 ? normalized.slice(0, 120) : null;
    if (compacted && key && getWorkbenchThreadItemIdentityKind(item) === "provisional" && narrativeKeys.has(key)) continue;
    if (key) narrativeKeys.add(key);
    if (item.type === "contextCompaction") compacted = true;
    if (item.type === "agentMessage" && (!isVisibleWorkbenchAgentMessageText(item.text) || hidden.controlAgentMessages)) continue;
    if (item.type === "userMessage" && hidden.controlUserMessages && isWorkbenchHiddenSystemSteerInput(item.content)) continue;
    const incoming = readIncomingAgentMessageItem(item);
    if (incoming) {
      flush();
      if (incoming.type === "userMessage" && getUserMessageDeliveryState(incoming) !== null) {
        heldAgentMessages.push(incoming);
        continue;
      }
      const previous = blocks.at(-1);
      if (previous?.kind === "agentMessageSequence" && previous.state === "delivered") previous.items.push(incoming);
      else blocks.push({ items: [incoming], kind: "agentMessageSequence", state: "delivered" });
      continue;
    }
    if (item.type === "userMessage") {
      const steerState = getMergeableSteerState(item);
      if (steerState) {
        flush();
        const previous = blocks.at(-1);
        if (previous?.kind === "userMessageSequence" && previous.state === steerState) {
          previous.items.push(item);
        } else if (previous?.kind === "item"
          && previous.item.type === "userMessage"
          && getMergeableSteerState(previous.item) === steerState) {
          blocks[blocks.length - 1] = {
            items: [previous.item, item],
            kind: "userMessageSequence",
            state: steerState,
          };
        } else {
          blocks.push({ item, kind: "item" });
        }
        continue;
      }
    }
    if (item.type === "commandExecution") {
      if (!isHiddenCommandExecution(item.command)) commands(item);
      continue;
    }
    if (item.type === "mcpToolCall" && !isNativeFileOperation(item)) {
      const shell = getWorkbenchMcpShellCommandItem(item, fallbackCwd);
      if (shell) { if (!isHiddenCommandExecution(shell.command)) commands(shell); continue; }
      const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
      if (route?.kind === "simple" && route.rendering.result.omitFromDisplay) continue;
      if (route?.kind === "simple" && route.rendering.claimedBy !== "browse.command") { commands(item); continue; }
    }
    if (item.type === "reasoning") {
      const visible = omitThreadReasoningStep(item, hidden.reasoningStep);
      if (!visible || !hasReasoningSteps(visible)) continue;
      if (pending?.kind !== "reasoningSequence") { flush(); pending = { kind: "reasoningSequence", items: [] }; }
      pending.items.push(visible);
      continue;
    }
    if (item.type === "dynamicToolCall" && (hidden.dynamicToolCallIds?.has(item.id)
      || item.namespace === "opencode" && item.tool === "execute"
      && item.toolCallGroupId && rolloverGroups.has(item.toolCallGroupId))) {
      flush();
      continue;
    }
    if (item.type === "fileChange" || isNativeFileOperation(item)) {
      if (item.type !== "fileChange" && item.status === "inProgress" && !getNativeFileChanges(item).length) continue;
      if (pending?.kind !== "fileChangeSequence") { flush(); pending = { kind: "fileChangeSequence", items: [] }; }
      pending.items.push(item);
      continue;
    }
    if (item.type === "dynamicToolCall" && isNativeCommandToolCall(item)) {
      commands(item);
      continue;
    }
    if (item.type === "webSearch") {
      if (pending?.kind !== "webSearchSequence") flush();
      if (hidden.webSearchItemIds?.has(item.id) || isThreadWebSearchPlaceholder(item)) continue;
      if (pending?.kind !== "webSearchSequence") pending = { kind: "webSearchSequence", items: [] };
      pending.items.push(item);
      continue;
    }
    flush();
    if (item.type === "agentMessage" && item.phase !== "final_answer") {
      const previous = blocks.at(-1);
      if (previous?.kind === "agentCommentarySequence") previous.items.push(item);
      else blocks.push({ items: [item], kind: "agentCommentarySequence" });
      continue;
    }
    blocks.push({ kind: "item", item, ...(item.type === "dynamicToolCall" && item.namespace === "opencode"
      && item.tool === "execute" && item.toolCallGroupId && capturedGroups.has(item.toolCallGroupId)
      ? { hasCapturedChildren: true } : {}) });
  }
  flush();
  if (heldAgentMessages.length) {
    // Held agent messages sit together directly above the user's own held steers.
    const heldBlock: ThreadRenderableBlock = { items: heldAgentMessages, kind: "agentMessageSequence", state: "held" };
    const firstHeldSteer = blocks.findIndex(isHeldUserSteerBlock);
    blocks.splice(firstHeldSteer < 0 ? blocks.length : firstHeldSteer, 0, heldBlock);
  }
  return foldSubagentCoordination(foldSubagentWaitExchanges(blocks));
}

type CommandContext = {
  /** Items that requested approval keep their own summary line, so the approval glyph stays visible. */
  approvalItemIds?: { has(itemId: string): boolean };
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
};

export function isBrowseCommandItem({ item, ...context }: CommandContext & { item: CommandSequenceItem }) {
  return item.type === "commandExecution" && isBrowseCommandMatcherClaim(getThreadCommandDisplay({
    command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell: item.shell, ...context,
  }).claimedBy);
}

export type CommandSequenceRenderSegment =
  | { items: CommandSequenceItem[]; kind: "commands" }
  | { items: [CommandSequenceItem]; kind: "approval" }
  | { action: NonNullable<ReturnType<typeof getGitArcMatcherAction>>; item: CommandItem; kind: "gitArc" }
  | { item: CommandItem; kind: "message" }
  | { item: CommandItem; kind: "subagent" }
  | { item: CommandItem; kind: "threadContext"; operation: WorkbenchThreadRecallOperation }
  | { group: ThreadSubagentWaitRenderGroup<CommandItem>; kind: "subagentWait" }
  | { item: CommandItem; kind: "threadStatus"; status: "blocked" | "completed" }
  | { item: CommandItem; kind: "threadTitle"; title: string };

export function buildCommandSequenceRenderSegments({ items, ...context }: CommandContext & { items: CommandSequenceItem[] }) {
  const segments: CommandSequenceRenderSegment[] = [];
  let commands: CommandSequenceItem[] = [];
  let waits: ThreadSubagentWaitRenderEntry<CommandItem>[] = [];
  const flushCommands = () => { if (commands.length) segments.push({ kind: "commands", items: commands }); commands = []; };
  const flushWaits = () => {
    segments.push(...groupThreadSubagentWaitRenderEntries(waits).map(group => ({ kind: "subagentWait" as const, group })));
    waits = [];
  };
  for (const item of items) {
    if (context.approvalItemIds?.has(item.id)) {
      flushCommands(); flushWaits(); segments.push({ kind: "approval", items: [item] }); continue;
    }
    if (item.type === "mcpToolCall") {
      flushWaits();
      if (item.status !== "completed" || item.error) { flushCommands(); segments.push({ kind: "commands", items: [item] }); }
      else commands.push(item);
      continue;
    }
    if (item.type === "dynamicToolCall") {
      flushWaits();
      if (item.success === false || item.status !== "completed") {
        flushCommands();
        segments.push({ kind: "commands", items: [item] });
      } else {
        commands.push(item);
      }
      continue;
    }
    const outcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
    const display = getThreadCommandDisplay({ command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell: item.shell, ...context });
    const title = isWorkbenchTaskTitleSetMatcherClaim(display.claimedBy) ? parseWorkbenchTaskTitleCommand(display.unwrappedCommand, item.commandActions) : null;
    const status = isWorkbenchTaskStatusMatcherClaim(display.claimedBy) ? parseWorkbenchTaskStatusCommand(display.unwrappedCommand, item.commandActions) : null;
    const recall = isThreadContextMatcherClaim(display.claimedBy) ? parseWorkbenchThreadRecallCommand(display.unwrappedCommand) : null;
    if (recall && (outcome === "completed" || outcome === "inProgress")) {
      flushCommands(); flushWaits(); segments.push({ kind: "threadContext", item, operation: recall }); continue;
    }
    if (title?.action === "set") { flushCommands(); flushWaits(); segments.push({ kind: "threadTitle", item, title: title.title }); continue; }
    if (status && (outcome === "completed" || outcome === "inProgress")) {
      flushCommands(); flushWaits(); segments.push({ kind: "threadStatus", item, status: status.status }); continue;
    }
    const gitArcAction = getGitArcMatcherAction(display.claimedBy);
    if (gitArcAction) { flushCommands(); flushWaits(); segments.push({ action: gitArcAction, kind: "gitArc", item }); continue; }
    const message = parseWorkbenchMessageCommand(display.unwrappedCommand, item.commandActions);
    if (message) { flushCommands(); flushWaits(); segments.push({ kind: "message", item }); continue; }
    const subagent = parseWorkbenchSubagentCommand(display.unwrappedCommand, item.commandActions);
    if (subagent?.action === "wait" && subagent.targets.length) {
      flushCommands();
      waits.push({ item, outcome, targetKeys: subagent.targets.map(getWorkbenchSubagentCommandTargetKey) });
      continue;
    }
    flushWaits();
    if (subagent) { flushCommands(); segments.push({ kind: "subagent", item }); continue; }
    if (outcome !== "completed") { flushCommands(); segments.push({ kind: "commands", items: [item] }); continue; }
    commands.push(item);
  }
  flushCommands(); flushWaits();
  return segments;
}

export function getWorkedBlockRows(block: ThreadRenderableBlock, context: CommandContext = {}): Array<{ block: ThreadRenderableBlock; eligible: boolean }> {
  if (block.kind !== "commandSequence") {
    // Exchanges hold delivered messages, which never hide inside a worked summary.
    if (block.kind === "userMessageSequence" || block.kind === "agentMessageSequence" || block.kind === "agentCommentarySequence"
      || block.kind === "subagentWaitExchange" || block.kind === "subagentCoordination") {
      return [{ block, eligible: false }];
    }
    if (block.kind === "item" && block.item.type === "functionCallOutput") {
      const output = readWorkbenchToolOutput(block.item);
      if (output?.namespace === "workbench" && output.name === "patch_recovery") return [];
      return [{ block, eligible: Boolean(output && !(output.namespace === "workbench" && output.name === "agent_message")) }];
    }
    // Narrative and unclassified interaction payloads are boundaries, never hidden by inference.
    const eligible = block.kind !== "item" || (block.item.type === "mcpToolCall" && (() => {
      const route = getWorkbenchMcpCommandRoute({ argumentsValue: block.item.arguments, server: block.item.server, tool: block.item.tool });
      if (route?.kind !== "specialized") return false;
      if (route.operation.kind === "gitArc") return route.operation.operation.action !== "propose";
      return route.operation.kind === "gitArcWait" || route.operation.kind === "threadRecall"
        || (route.operation.kind === "subagent" && route.operation.operation.action !== "create");
    })());
    return [{ block, eligible }];
  }
  const segments = buildCommandSequenceRenderSegments({ items: block.items, ...context });
  const standalone = segments.some(segment => segment.kind !== "commands");
  if (!standalone) {
    if (block.items.length > 1 && block.items.every(item => isBrowseCommandItem({ item, ...context }))) {
      return block.items.map(item => ({ block: { kind: "commandSequence", items: [item] }, eligible: true }));
    }
    return [{ block, eligible: true }];
  }
  return segments.flatMap<{ block: ThreadRenderableBlock; eligible: boolean }>(segment => {
    if (segment.kind === "approval") return [{ block: { kind: "commandSequence" as const, items: segment.items }, eligible: true }];
    if (segment.kind === "commands") {
      return segment.items.length > 1 && segment.items.every(item => isBrowseCommandItem({ item, ...context }))
        ? segment.items.map(item => ({ block: { kind: "commandSequence" as const, items: [item] }, eligible: true }))
        : [{ block: { kind: "commandSequence" as const, items: segment.items }, eligible: true }];
    }
    if (segment.kind === "subagentWait") {
      return [{ block: { kind: "commandSequence" as const, items: segment.group.entries.map(entry => entry.item) }, eligible: true }];
    }
    const subagent = segment.kind === "subagent" ? parseWorkbenchSubagentCommand(
      getThreadCommandDisplay({ command: segment.item.command, commandActions: segment.item.commandActions, cwd: segment.item.cwd, shell: segment.item.shell, ...context }).unwrappedCommand,
      segment.item.commandActions,
    ) : null;
    return [{
      block: { kind: "commandSequence" as const, items: [segment.item] },
      eligible: (segment.kind === "gitArc" && segment.action !== "propose") || segment.kind === "threadContext"
        || Boolean(subagent && subagent.action !== "create"),
    }];
  });
}
