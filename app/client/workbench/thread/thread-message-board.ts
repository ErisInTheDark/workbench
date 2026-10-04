/*
 * Exports:
 * - ThreadMessageBoardMessage: one message exchanged with a thread agent, with sender or target and optional user-visible simple version.
 * - deriveThreadMessageBoardHistory: project a thread's loaded turns into its ordered incoming and outgoing message history.
 */
import type { ThreadPayload } from "workbench-shared/types";
import { readWorkbenchAgentMessageInput, readWorkbenchAgentMessageItem } from "workbench-shared/workbench/thread/thread-agent-message";
import { findWorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import { isWorkbenchHiddenSystemSteerInput, stripWorkbenchTurnEndMarker } from "workbench-shared/workbench/thread/thread-recovery-message";
import { unwrapWorkbenchSteerDisplayInput } from "workbench-shared/workbench/thread/thread-steer-display";
import { isAgentScreenshotSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-markers";
import type { ThreadItem, UserInput } from "workbench-shared/workbench/thread/workbench-thread-items";
import { getWorkbenchMcpCommandRoute } from "./thread-command-matchers";

type BoardTurn = Pick<ThreadPayload["turns"][number], "completedAt" | "id" | "items" | "startedAt" | "status">;
type BoardTurnHistory = Pick<ThreadPayload["turnHistory"][number], "itemTimeline" | "turnId">;

type ThreadMessageBoardContent = { markdown: string; userVisibleSimpleVersion: string | null } & (
  | { direction: "incoming"; sender: { name: string; threadId: string } | null }
  | { direction: "outgoing"; target: { kind: "final" } | { kind: "name" | "parent" | "thread"; value: string | null } }
);

export type ThreadMessageBoardMessage = ThreadMessageBoardContent & { id: string; timestampSeconds: number | null };

function readInputMarkdown(input: readonly UserInput[]) {
  return input.flatMap((entry) => entry.type === "text" ? [entry.text.trim()] : []).filter(Boolean).join("\n\n");
}

function isFailedCall(item: Extract<ThreadItem, { type: "mcpToolCall" }>) {
  return item.status === "failed" || Boolean(item.error);
}

function getFinalAnswerIds(turn: BoardTurn) {
  const messages = turn.items.filter((item): item is Extract<ThreadItem, { type: "agentMessage" }> => item.type === "agentMessage");
  if (messages.some((message) => message.phase !== null)) {
    return new Set(messages.filter((message) => message.phase === "final_answer").map(({ id }) => id));
  }
  // Providers without phases still hand their last completed-turn message back to waiting parents.
  const last = turn.status === "completed" ? messages.at(-1) : undefined;
  return new Set(last ? [last.id] : []);
}

function readItemMessage(
  item: ThreadItem,
  finalAnswerIds: ReadonlySet<string>,
): ThreadMessageBoardContent | null {
  if (item.type === "userMessage") {
    if (isAgentScreenshotSteerUserMessage(item) || isWorkbenchHiddenSystemSteerInput(item.content)) return null;
    const agentMessage = readWorkbenchAgentMessageInput(item.content);
    if (agentMessage) {
      return {
        direction: "incoming",
        markdown: agentMessage.message,
        sender: { name: agentMessage.senderName, threadId: agentMessage.senderThreadId },
        userVisibleSimpleVersion: agentMessage.userVisibleSimpleVersion ?? null,
      };
    }
    const markdown = readInputMarkdown(unwrapWorkbenchSteerDisplayInput(item.content));
    return markdown ? { direction: "incoming", markdown, sender: null, userVisibleSimpleVersion: null } : null;
  }
  if (item.type === "functionCallOutput") {
    const agentMessage = readWorkbenchAgentMessageItem(item);
    return agentMessage ? {
      direction: "incoming",
      markdown: agentMessage.message,
      sender: { name: agentMessage.senderName, threadId: agentMessage.senderThreadId },
      userVisibleSimpleVersion: agentMessage.userVisibleSimpleVersion ?? null,
    } : null;
  }
  if (item.type === "mcpToolCall") {
    if (isFailedCall(item)) return null;
    const route = getWorkbenchMcpCommandRoute({ argumentsValue: item.arguments, server: item.server, tool: item.tool });
    if (route?.kind !== "specialized" || route.operation.kind !== "message" || !route.operation.operation.message) return null;
    const { message, target, userVisibleSimpleVersion } = route.operation.operation;
    return { direction: "outgoing", markdown: message, target, userVisibleSimpleVersion };
  }
  if (item.type === "agentMessage" && finalAnswerIds.has(item.id)) {
    const markdown = stripWorkbenchTurnEndMarker(item.text).trim();
    return markdown ? { direction: "outgoing", markdown, target: { kind: "final" }, userVisibleSimpleVersion: null } : null;
  }
  return null;
}

export function deriveThreadMessageBoardHistory(
  turns: readonly BoardTurn[],
  turnHistory: readonly BoardTurnHistory[] = [],
): ThreadMessageBoardMessage[] {
  const timelines = new Map(turnHistory.map((entry) => [entry.turnId, entry.itemTimeline ?? []]));
  return turns.flatMap((turn) => {
    const finalAnswerIds = getFinalAnswerIds(turn);
    const timeline = timelines.get(turn.id) ?? [];
    return turn.items.flatMap((item) => {
      const message = readItemMessage(item, finalAnswerIds);
      if (!message) return [];
      // Timeline entries are milliseconds; turn bounds are already seconds.
      const entry = findWorkbenchThreadItemTimelineEntry(item.id, timeline);
      const observedMs = entry?.firstSeenAt ?? entry?.startedAt ?? null;
      const fallback = message.direction === "outgoing" && message.target.kind === "final" ? turn.completedAt : turn.startedAt;
      const located: ThreadMessageBoardMessage = { ...message, id: item.id, timestampSeconds: observedMs !== null ? observedMs / 1_000 : fallback ?? null };
      return [located];
    });
  });
}
