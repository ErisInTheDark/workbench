/*
 * Exports:
 * - LiveThreadActivity: current reasoning, search, or command status presentation.
 * - ThreadTerminalEntry: one canonical command projected for terminal display.
 * - getThreadTerminalEntries: derive command history without changing canonical order.
 * - getLiveThreadActivity: select reasoning first, then ongoing command summaries.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { ThreadPayload, WorkbenchPendingUserInputRequest, WorkbenchSkillSummary } from "workbench-shared/types";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { isPendingInitialOptimisticInputItem } from "../../../workbench/thread/ThreadOptimisticInputStore";
import {
  getThreadCommandDisplay, getThreadCommandBlockDisplay, getThreadCommandExecutionOutcome,
  getWorkbenchMcpCommandRoute, getWorkbenchMcpShellCommandItem, getWorkbenchCommandRouteSummaryDisplay,
  type ThreadCommandSummaryDisplay,
  type ThreadCommandExecutionOutcome,
} from "../../../workbench/thread/thread-command-matchers";
import { getCurrentThreadReasoningActivity, type ThreadReasoningStepReference } from "./thread-reasoning-display";
import { getThreadWebSearchLiveLabel, isThreadWebSearchPlaceholder } from "./thread-web-search-state";
import { isHiddenCommandExecution } from "./thread-render-blocks";
import { formatDynamicToolInvocation, formatMcpToolInvocation, formatToolCallOutput } from "./format-thread-tool-call";

export type LiveThreadActivity =
  | { kind: "reasoning"; body: string | null; hiddenStep: ThreadReasoningStepReference | null; markdown: string | null; title: string }
  | { kind: "webSearch"; contextItems: Array<Extract<ThreadItem, { type: "webSearch" }>>; hiddenItemIds: string[]; title: string }
  | { kind: "commands"; title: string };

export interface ThreadTerminalEntry {
  id: string;
  command: string;
  output: string;
  status: ThreadCommandExecutionOutcome;
  streamsOutput: boolean;
  display: ThreadCommandSummaryDisplay | null;
}

export function getThreadTerminalEntries(items: readonly ThreadItem[], context: {
  cwd: string;
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}): ThreadTerminalEntry[] {
  return items.flatMap<ThreadTerminalEntry>(item => {
    const command = item.type === "commandExecution" ? item
      : item.type === "mcpToolCall" ? getWorkbenchMcpShellCommandItem(item, context.cwd) : null;
    if (command) {
      if (isHiddenCommandExecution(command.command)) return [];
      const status = getThreadCommandExecutionOutcome(command.status, command.exitCode);
      return [{
        id: item.id, command: command.command, output: command.aggregatedOutput ?? "",
        status,
        streamsOutput: item.type === "commandExecution",
        display: status === "inProgress" ? getThreadCommandDisplay({ ...context, ...command }) : null,
      }];
    }
    if (item.type === "mcpToolCall") {
      const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, context, server: item.server, tool: item.tool });
      if (route?.kind === "simple" && route.rendering.result.omitFromDisplay) return [];
      return [{
        id: item.id,
        command: formatMcpToolInvocation({ argumentsValue: item.arguments, server: item.server, tool: item.tool }),
        output: item.error?.message || formatToolCallOutput({ content: item.result?.content, fallback: item.result?.structuredContent ?? item.result?._meta }),
        status: item.error ? "failed" : item.status, streamsOutput: false,
        display: item.status === "inProgress" && !item.error ? getWorkbenchCommandRouteSummaryDisplay(route) : null,
      }];
    }
    if (item.type === "dynamicToolCall") return [{
      id: item.id,
      command: formatDynamicToolInvocation({ argumentsValue: item.arguments, namespace: item.namespace, tool: item.tool }),
      output: formatToolCallOutput({ content: item.contentItems }),
      status: item.success === false ? "failed" : item.status, streamsOutput: false, display: null,
    }];
    return [];
  });
}

export function getLiveThreadActivity({ pendingUserInputRequest, turn, commands = [] }: {
  pendingUserInputRequest: WorkbenchPendingUserInputRequest | null;
  turn: ThreadPayload["turns"][number] | null;
  commands?: readonly ThreadTerminalEntry[];
}): LiveThreadActivity | null {
  if (!turn || turn.status !== "inProgress" || pendingUserInputRequest) return null;
  const idle = (title: string): LiveThreadActivity => ({ kind: "reasoning", title, body: null, markdown: null, hiddenStep: null });
  if (turn.items.some(isPendingInitialOptimisticInputItem)) return idle("Connecting");
  const reasoning = getCurrentThreadReasoningActivity(turn);
  if (reasoning) return { kind: "reasoning", ...reasoning };
  const running = commands.filter(entry => entry.status === "inProgress");
  if (running.length) {
    const matched = running.flatMap(entry => entry.display ? [{ display: entry.display }] : []);
    const unmatched = running.length - matched.length;
    const summary = matched.length === 1 ? matched[0]!.display.ongoingSummaryText
      : matched.length ? getThreadCommandBlockDisplay({ items: matched }).ongoingSummaryText : "";
    return { kind: "commands", title: [
      summary, unmatched ? `Running ${unmatched} tool${unmatched === 1 ? "" : "s"}` : "",
    ].filter(Boolean).join(", ") };
  }
  const latest = turn.items.at(-1);
  if (latest?.type === "contextCompaction") return null;
  if (latest?.type === "webSearch" && isThreadWebSearchPlaceholder(latest)) {
    const contextItems: Array<Extract<ThreadItem, { type: "webSearch" }>> = [];
    for (let index = turn.items.length - 2; index >= 0; index--) {
      const item = turn.items[index]!;
      if (item.type === "reasoning" && ![...item.summary, ...item.content].some(section => section.trim())) continue;
      if (item.type === "agentMessage" && !item.text.trim()) continue;
      if (item.type !== "webSearch") break;
      if (!isThreadWebSearchPlaceholder(item)) contextItems.unshift(item);
    }
    return { kind: "webSearch", title: getThreadWebSearchLiveLabel(latest), contextItems, hiddenItemIds: [latest.id, ...contextItems.map(item => item.id)] };
  }
  return idle("Thinking");
}
