/*
 * Exports:
 * - CommandItem/CommandSequenceItem/ThreadRenderableBlock/HiddenThreadItemIds: shared render-plan shapes.
 * - buildRenderableBlocks: group visible provider items before rendering.
 * - isHiddenCommandExecution/hasReasoningSteps: shared visibility decisions.
 * - CommandSequenceRenderSegment/buildCommandSequenceRenderSegments: final command presentation groups.
 * - isBrowseCommandItem: identify commands rendered separately as Browse requests.
 * - getWorkedBlockRows: split independently rendered work rows and identify protected content.
 */
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { WorkbenchSkillSummary } from "workbench-shared/types";
import { isWorkbenchActivatedSkillsInput } from "workbench-shared/workbench/thread/thread-activated-skills";
import { getWorkbenchThreadItemIdentityKind } from "workbench-shared/workbench/thread/thread-item-identity";
import { isWorkbenchHiddenSystemSteerInput } from "workbench-shared/workbench/thread/thread-recovery-message";
import { isSyntheticQuestionnaireHistoryItem } from "workbench-shared/workbench/thread/thread-questionnaire-history";
import { readWorkbenchToolOutput } from "workbench-shared/workbench/thread/thread-tool-output";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import {
  getThreadCommandDisplay, getThreadCommandExecutionOutcome, getGitArcMatcherAction,
  getWorkbenchMcpCommandRoute, getWorkbenchMcpShellCommandItem,
  isBrowseCommandMatcherClaim, isThreadContextMatcherClaim,
  isWorkbenchThreadStatusMatcherClaim, isWorkbenchThreadTitleSetMatcherClaim,
  parseWorkbenchSubagentCommand, parseWorkbenchThreadStatusCommand, parseWorkbenchThreadTitleCommand,
  type CommandShell,
} from "../../../workbench/thread/thread-command-matchers";
import { getWorkbenchSubagentCommandTargetKey } from "../../../workbench/thread/thread-subagents";
import { omitThreadReasoningStep, type ThreadReasoningStepReference } from "./thread-reasoning-display";
import { isThreadWebSearchPlaceholder } from "./thread-web-search-state";
import { groupThreadSubagentWaitRenderEntries, type ThreadSubagentWaitRenderEntry, type ThreadSubagentWaitRenderGroup } from "./thread-subagent-wait-groups";

export type CommandItem = Extract<ThreadItem, { type: "commandExecution" }> & { shell?: CommandShell };
export type CommandSequenceItem = CommandItem | Extract<ThreadItem, { type: "mcpToolCall" }>;
export type ThreadRenderableBlock =
  | { kind: "commandSequence"; items: CommandSequenceItem[] }
  | { kind: "fileChangeSequence"; items: Extract<ThreadItem, { type: "fileChange" }>[] }
  | { kind: "reasoningSequence"; items: Extract<ThreadItem, { type: "reasoning" }>[] }
  | { kind: "webSearchSequence"; items: Extract<ThreadItem, { type: "webSearch" }>[] }
  | { kind: "item"; item: Exclude<ThreadItem, { type: "commandExecution" | "fileChange" | "reasoning" }> };

export interface HiddenThreadItemIds {
  controlAgentMessages?: boolean;
  controlUserMessages?: boolean;
  dynamicToolCallIds?: ReadonlySet<string> | null;
  itemIds?: ReadonlySet<string> | null;
  reasoningStep?: ThreadReasoningStepReference | null;
  webSearchItemIds?: ReadonlySet<string> | null;
}

export function isHiddenCommandExecution(command: string) {
  if (/^report_intent(?:\s|$)/i.test(command.trim())) return true;
  const display = getThreadCommandDisplay({ command, commandActions: [], cwd: "" });
  const dedicated = getGitArcMatcherAction(display.claimedBy)
    || isThreadContextMatcherClaim(display.claimedBy)
    || isWorkbenchThreadStatusMatcherClaim(display.claimedBy)
    || isWorkbenchThreadTitleSetMatcherClaim(display.claimedBy)
    || display.claimedBy?.split(",").includes("workbench-cli.subagent");
  return display.omitFromDisplay && !dedicated;
}

export function hasReasoningSteps(item: Extract<ThreadItem, { type: "reasoning" }>) {
  return item.summary.some(section => section.trim()) || item.content.some(section => section.trim());
}

export function buildRenderableBlocks(items: ThreadItem[], hidden: HiddenThreadItemIds = {}, fallbackCwd = "."): ThreadRenderableBlock[] {
  const blocks: ThreadRenderableBlock[] = [];
  let pending: Exclude<ThreadRenderableBlock, { kind: "item" }> | null = null;
  const flush = () => { if (pending) blocks.push(pending); pending = null; };
  const commands = (item: CommandSequenceItem) => {
    if (pending?.kind !== "commandSequence") { flush(); pending = { kind: "commandSequence", items: [] }; }
    pending.items.push(item);
  };
  const hasQuestionnaire = items.some(isSyntheticQuestionnaireHistoryItem);
  const narrativeKeys = new Set<string>();
  let compacted = false;
  for (const item of items) {
    if (hidden.itemIds?.has(item.id)) continue;
    if (item.type === "userMessage" && (isWorkbenchHiddenSystemSteerInput(item.content)
      || (item.content.length > 0 && item.content.every(isWorkbenchActivatedSkillsInput)))) continue;
    const text = item.type === "agentMessage" || item.type === "plan" ? item.text
      : item.type === "reasoning" ? [...item.summary, ...item.content].join("\n") : null;
    const normalized = text?.replace(/\s+/gu, " ").replace(/[^\p{L}\p{N}\s#`./:-]+/gu, "").trim().toLowerCase();
    const key = normalized && normalized.length >= 40 ? normalized.slice(0, 120) : null;
    if (compacted && key && getWorkbenchThreadItemIdentityKind(item) === "provisional" && narrativeKeys.has(key)) continue;
    if (key) narrativeKeys.add(key);
    if (item.type === "contextCompaction") compacted = true;
    if (item.type === "agentMessage" && (!item.text.trim() || hidden.controlAgentMessages)) continue;
    if (item.type === "userMessage" && hidden.controlUserMessages && isWorkbenchHiddenSystemSteerInput(item.content)) continue;
    if (item.type === "commandExecution") {
      if (!isHiddenCommandExecution(item.command)) commands(item);
      continue;
    }
    if (item.type === "mcpToolCall") {
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
    if (item.type === "fileChange") {
      if (pending?.kind !== "fileChangeSequence") { flush(); pending = { kind: "fileChangeSequence", items: [] }; }
      pending.items.push(item);
      continue;
    }
    if (item.type === "webSearch") {
      if (pending?.kind !== "webSearchSequence") flush();
      if (hidden.webSearchItemIds?.has(item.id) || isThreadWebSearchPlaceholder(item)) continue;
      if (pending?.kind !== "webSearchSequence") pending = { kind: "webSearchSequence", items: [] };
      pending.items.push(item);
      continue;
    }
    if (item.type === "dynamicToolCall" && (hidden.dynamicToolCallIds?.has(item.id)
      || (hasQuestionnaire && item.namespace === "opencode" && item.tool === "question"))) { flush(); continue; }
    flush();
    blocks.push({ kind: "item", item });
  }
  flush();
  return blocks;
}

type CommandContext = {
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
  | { item: CommandItem; kind: "gitArc" }
  | { item: CommandItem; kind: "subagent" }
  | { item: CommandItem; kind: "threadContext" }
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
    if (item.type === "mcpToolCall") {
      flushWaits();
      if (item.status !== "completed" || item.error) { flushCommands(); segments.push({ kind: "commands", items: [item] }); }
      else commands.push(item);
      continue;
    }
    const outcome = getThreadCommandExecutionOutcome(item.status, item.exitCode);
    const display = getThreadCommandDisplay({ command: item.command, commandActions: item.commandActions, cwd: item.cwd, shell: item.shell, ...context });
    const title = isWorkbenchThreadTitleSetMatcherClaim(display.claimedBy) ? parseWorkbenchThreadTitleCommand(display.unwrappedCommand, item.commandActions) : null;
    const status = isWorkbenchThreadStatusMatcherClaim(display.claimedBy) ? parseWorkbenchThreadStatusCommand(display.unwrappedCommand, item.commandActions) : null;
    if (isThreadContextMatcherClaim(display.claimedBy) && (outcome === "completed" || outcome === "inProgress")) {
      flushCommands(); flushWaits(); segments.push({ kind: "threadContext", item }); continue;
    }
    if (title?.action === "set") { flushCommands(); flushWaits(); segments.push({ kind: "threadTitle", item, title: title.title }); continue; }
    if (status && (outcome === "completed" || outcome === "inProgress")) {
      flushCommands(); flushWaits(); segments.push({ kind: "threadStatus", item, status: status.status }); continue;
    }
    if (getGitArcMatcherAction(display.claimedBy)) { flushCommands(); flushWaits(); segments.push({ kind: "gitArc", item }); continue; }
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
    if (block.kind === "item" && block.item.type === "functionCallOutput") {
      const output = readWorkbenchToolOutput(block.item);
      if (output?.namespace === "workbench" && output.name === "patch_recovery") return [];
      return [{ block, eligible: Boolean(output && !(output.namespace === "workbench" && output.name === "agent_message")) }];
    }
    // Narrative and unclassified interaction payloads are boundaries, never hidden by inference.
    const eligible = block.kind !== "item" || (block.item.type === "mcpToolCall" && (() => {
      const route = getWorkbenchMcpCommandRoute({ argumentsValue: block.item.arguments, server: block.item.server, tool: block.item.tool });
      return route?.kind === "specialized" && (route.operation.kind === "gitArc" || route.operation.kind === "gitArcWait" || route.operation.kind === "threadRecall"
        || (route.operation.kind === "subagent" && route.operation.operation.action !== "create" && route.operation.operation.action !== "message"));
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
    return [{ block: { kind: "commandSequence" as const, items: [segment.item] }, eligible: segment.kind === "gitArc" || segment.kind === "threadContext"
      || Boolean(subagent && subagent.action !== "create" && subagent.action !== "message") }];
  });
}
