/*
 * Exports:
 * - ThreadLiveCommandContext: matcher context for naming running calls.
 * - getLiveThreadVerb: a live turn's simplest current action (Thinking, Reading, Proposing...), or null when nothing is live.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { isWorkbenchPendingSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-history";
import { WorkbenchShellResultSchema } from "workbench-shared/workbench/commands/workbench-shell-command";
import type { ThreadPayload, WorkbenchPendingUserInputRequest, WorkbenchSkillSummary } from "workbench-shared/types";
import type { WorkspaceFileLinkRoot } from "../../../workbench/markdown/markdown-links";
import { isPendingInitialOptimisticInputItem } from "../../../workbench/thread/thread-optimistic-items";
import {
  getNativeToolDisplay, getThreadCommandDisplay, getThreadCommandExecutionOutcome,
  getWorkbenchMcpCommandRoute, getWorkbenchMcpShellCommandItem,
} from "../../../workbench/thread/thread-command-matchers";
import { summarizeDisplayParts } from "../../../workbench/thread/command-matchers/helpers";
import { isThreadWebSearchPlaceholder } from "./thread-web-search-state";
import { isHiddenCommandExecution } from "./thread-render-blocks";

export interface ThreadLiveCommandContext {
  cwd: string;
  knownSkills?: WorkbenchSkillSummary[];
  projectRootPath?: string;
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}

/** What a call says while no matcher describes it. */
const UNMATCHED_VERB = "Executing";
const GERUND = /^[A-Za-z]+ing$/u;

/** The leading gerund of an ongoing summary (`Reading x`, `Browsing: x`), past a `cwd: ` prefix. */
function ongoingVerb(text: string) {
  for (const word of text.trim().split(/\s+/u, 2)) {
    const bare = word.replace(/:$/u, "");
    if (GERUND.test(bare)) return `${bare[0]!.toUpperCase()}${bare.slice(1)}`;
    if (bare === word) break;
  }
  return null;
}

/** A running visible call's verb; null for settled, hidden or omitted calls. */
function runningCallVerb(item: ThreadItem, context: ThreadLiveCommandContext): string | null {
  if (item.type === "fileChange") {
    if (item.status !== "inProgress") return null;
    const kinds = new Set(item.changes.map(change => change.kind.type));
    return kinds.size === 1 && kinds.has("add") ? "Creating" : kinds.size === 1 && kinds.has("delete") ? "Deleting" : "Editing";
  }
  if (item.type === "dynamicToolCall") {
    if (item.status !== "inProgress" || item.success === false) return null;
    const display = getNativeToolDisplay(item, context);
    return (display && ongoingVerb(display.ongoingSummaryText)) ?? UNMATCHED_VERB;
  }
  const shell = item.type === "mcpToolCall" ? getWorkbenchMcpShellCommandItem(item, context.cwd) : null;
  const command = item.type === "commandExecution" ? item : shell;
  if (command) {
    if (isHiddenCommandExecution(command.command)) return null;
    if (item.type === "mcpToolCall") {
      const result = WorkbenchShellResultSchema.safeParse(item.result?.structuredContent);
      if (item.error || getThreadCommandExecutionOutcome(item.status, result.success ? result.data.exitCode : null) !== "inProgress") return null;
    } else if (getThreadCommandExecutionOutcome(command.status, command.exitCode) !== "inProgress") return null;
    const display = getThreadCommandDisplay({
      ...context, command: command.command, commandActions: command.commandActions, cwd: command.cwd, shell: shell?.shell,
    });
    return (display.summaryKind === "matched" && ongoingVerb(display.ongoingSummaryText)) || UNMATCHED_VERB;
  }
  if (item.type !== "mcpToolCall" || item.error || item.status !== "inProgress") return null;
  const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, context, server: item.server, tool: item.tool });
  if (route?.kind === "simple" && route.rendering.result.omitFromDisplay) return null;
  return (route && ongoingVerb(summarizeDisplayParts(route.rendering.result.ongoingSummaryParts))) ?? UNMATCHED_VERB;
}

/** The newest running call's verb, counting an OpenCode execute wrapper only when no wb child it carries speaks for it. */
function newestRunningCallVerb(items: readonly ThreadItem[], context: ThreadLiveCommandContext) {
  const running = items.flatMap(item => {
    const verb = runningCallVerb(item, context);
    return verb ? [{ item, verb }] : [];
  });
  const runningIds = new Set(running.map(({ item }) => item.id));
  const childGroups = new Set(items.flatMap(item => item.type === "mcpToolCall" && item.server === "wb"
    && item.toolCallGroupId && runningIds.has(item.id) ? [item.toolCallGroupId] : []));
  const rolloverGroups = new Set(items.flatMap(item => item.type === "mcpToolCall" && item.server === "wb"
    && item.tool === "thread_compact" && item.toolCallGroupId ? [item.toolCallGroupId] : []));
  return running.findLast(({ item }) => !(item.type === "dynamicToolCall" && item.namespace === "opencode"
    && item.tool === "execute" && item.toolCallGroupId
    && (childGroups.has(item.toolCallGroupId) || rolloverGroups.has(item.toolCallGroupId))))?.verb ?? null;
}

export function getLiveThreadVerb({ context, pendingUserInputRequest, turn }: {
  context: ThreadLiveCommandContext;
  pendingUserInputRequest: WorkbenchPendingUserInputRequest | null;
  /** The thread's live turn; null when the thread is not working. */
  turn: ThreadPayload["turns"][number] | null;
}): string | null {
  if (!turn || pendingUserInputRequest) return null;
  const compacting = turn.items.some(item => item.type === "contextCompaction" && item.status === "inProgress");
  if (turn.items.some(isPendingInitialOptimisticInputItem) && !compacting) return "Connecting";
  if (turn.items.findLast(item => !isWorkbenchPendingSteerUserMessage(item))?.type === "reasoning") return "Thinking";
  const running = newestRunningCallVerb(turn.items, context);
  if (running) return running;
  if (compacting) return null;
  const latest = turn.items.at(-1);
  if (latest?.type === "contextCompaction") return null;
  return latest?.type === "webSearch" && isThreadWebSearchPlaceholder(latest) ? "Searching" : "Thinking";
}
