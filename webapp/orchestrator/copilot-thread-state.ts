/*
 * Exports:
 * - CopilotThreadState: in-memory Codex-shaped thread cache for a Copilot session. Keywords: copilot, thread state, session cache.
 * - INITIALIZE_RESULT/EMPTY_RATE_LIMITS: small bridge constants for Copilot responses. Keywords: initialize, rate limits.
 * - formatPromptFromInput/cloneThread: bridge helpers for sending prompts and returning thread snapshots. Keywords: prompt, clone, codex shape.
 * - createThreadState/metadataToThread/applyCopilotEvent: synthesize and incrementally update Codex-shaped threads from Copilot SDK events. Keywords: event translation, codex adapter, thread reconstruction.
 */
import { randomUUID } from "node:crypto";

import type { SessionEvent, SessionMetadata } from "@github/copilot-sdk";

import type { DynamicToolCallOutputContentItem } from "../lib/codex/generated/app-server/v2/DynamicToolCallOutputContentItem";
import type { RateLimitSnapshot } from "../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { ThreadActiveFlag } from "../lib/codex/generated/app-server/v2/ThreadActiveFlag";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import type { ThreadStatus } from "../lib/codex/generated/app-server/v2/ThreadStatus";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import { appendCommandOutputDelta, compactCommandOutput } from "../lib/codex/thread-command-output";
import type { JsonRpcNotification } from "./bridge-types";

export type CopilotThreadState = {
  currentTurnId: string | null;
  metadata: SessionMetadata | null;
  pendingUserInputs: UserInput[][];
  sessionId: string;
  thread: Thread;
  toolCallItems: Map<string, { itemId: string; turnId: string }>;
};

export const EMPTY_RATE_LIMITS: RateLimitSnapshot | null = null;
export const INITIALIZE_RESULT = {
  capabilities: {
    experimentalApi: true,
  },
  serverInfo: {
    name: "copilot-bridge",
    version: "0.1.0",
  },
};
const WORKBENCH_QUESTIONNAIRE_TOOL_NAME = "workbench_request_user_input";
const COPILOT_SKILL_TOOL_NAME = "skill";
const COPILOT_TASK_TOOL_NAME = "task";
const COPILOT_DYNAMIC_TOOL_METADATA_KEY = "__copilotWorkbench";
type DynamicToolCallItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function toUnixSeconds(value: Date | string | number | null | undefined) {
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
  }

  if (typeof value === "number") {
    return Math.floor(value / 1000);
  }

  return 0;
}

function toTurnDurationMs(turn: Turn) {
  if (turn.startedAt === null || turn.completedAt === null) {
    return null;
  }

  return Math.max(0, (turn.completedAt - turn.startedAt) * 1000);
}

export function cloneThread(thread: Thread) {
  return structuredClone(thread);
}

export function formatPromptFromInput(input: UserInput[]) {
  const parts: string[] = [];

  for (const entry of input) {
    switch (entry.type) {
      case "text":
        if (entry.text.trim()) {
          parts.push(entry.text.trim());
        }
        break;
      case "image":
        parts.push(`[Image attachment omitted from bridge payload: ${entry.url.slice(0, 120)}]`);
        break;
      case "localImage":
        parts.push(`[Local image: ${entry.path}]`);
        break;
      case "skill":
        parts.push(`[Skill reference: ${entry.name} (${entry.path})]`);
        break;
      case "mention":
        parts.push(`[Mention: ${entry.name} (${entry.path})]`);
        break;
    }
  }

  return parts.join("\n\n").trim();
}

function previewFromUserInputs(inputs: UserInput[][], fallback: string) {
  for (const input of inputs) {
    for (const entry of input) {
      if (entry.type === "text" && entry.text.trim()) {
        return entry.text.trim();
      }
    }
  }

  return fallback;
}

function buildTurnId(turnId: string, interactionId: unknown) {
  const stableInteractionId = asString(interactionId);
  return stableInteractionId ? `interaction:${stableInteractionId}` : `turn:${turnId}`;
}

function isFinalMessagePhase(phase: unknown) {
  return phase === "response" || phase === "final_answer";
}

function isLikelyFinalAssistantMessage(eventData: unknown) {
  const data = asRecord(eventData);
  if (!data) {
    return false;
  }

  if (isFinalMessagePhase(data.phase)) {
    return true;
  }

  const content = asString(data.content)?.trim() ?? "";
  const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
  return !!content && toolRequests.length === 0;
}

function makeUserMessageItem(content: UserInput[]): Extract<ThreadItem, { type: "userMessage" }> {
  return {
    content,
    id: `user:${randomUUID()}`,
    type: "userMessage",
  };
}

function makeReasoningItem(itemId: string): Extract<ThreadItem, { type: "reasoning" }> {
  return {
    content: [],
    id: itemId,
    summary: [],
    type: "reasoning",
  };
}

function makeAgentMessageItem(itemId: string): Extract<ThreadItem, { type: "agentMessage" }> {
  return {
    id: itemId,
    memoryCitation: null,
    phase: "commentary",
    text: "",
    type: "agentMessage",
  };
}

function splitReasoningSummaries(reasoningText: string) {
  const trimmedReasoningText = reasoningText.trim();
  if (!trimmedReasoningText) {
    return [];
  }

  const summaryStartIndexes = Array.from(
    trimmedReasoningText.matchAll(/\*\*[^*\n][^*\n]{0,120}\*\*\n\n/g),
    (match) => match.index ?? -1,
  ).filter((index) => index >= 0);

  if (summaryStartIndexes.length < 2) {
    return [trimmedReasoningText];
  }

  const segmentStartIndexes = summaryStartIndexes[0] === 0
    ? summaryStartIndexes
    : [0, ...summaryStartIndexes];
  const segments: string[] = [];

  for (let index = 0; index < segmentStartIndexes.length; index += 1) {
    const startIndex = segmentStartIndexes[index];
    const endIndex = segmentStartIndexes[index + 1] ?? trimmedReasoningText.length;
    const segment = trimmedReasoningText.slice(startIndex, endIndex).trim();
    if (segment) {
      segments.push(segment);
    }
  }

  return segments.length ? segments : [trimmedReasoningText];
}

function upsertMessageReasoningItem(
  turn: Turn,
  agentItem: Extract<ThreadItem, { type: "agentMessage" }>,
  reasoningText: string,
) {
  const itemId = `reasoning:${agentItem.id}`;
  let item = findItemById(turn, "reasoning", itemId);
  if (!item) {
    item = makeReasoningItem(itemId);
    const agentItemIndex = turn.items.findIndex((entry) => entry.id === agentItem.id);
    if (agentItemIndex === -1) {
      turn.items.push(item);
    } else {
      turn.items.splice(agentItemIndex, 0, item);
    }
  }

  const reasoningSections = splitReasoningSummaries(reasoningText);
  item.summary = reasoningSections;
  item.content = reasoningSections;
  return item;
}

function makeCommandExecutionItem(
  itemId: string,
  command: string,
  cwd: string,
): Extract<ThreadItem, { type: "commandExecution" }> {
  return {
    aggregatedOutput: null,
    command,
    commandActions: [],
    cwd,
    durationMs: null,
    exitCode: null,
    id: itemId,
    processId: null,
    source: "agent",
    status: "inProgress",
    type: "commandExecution",
  };
}

function makeDynamicToolCallItem(
  itemId: string,
  tool: string,
  argumentsValue: unknown,
): DynamicToolCallItem {
  return {
    arguments: (argumentsValue ?? null) as DynamicToolCallItem["arguments"],
    contentItems: null,
    durationMs: null,
    id: itemId,
    namespace: null,
    status: "inProgress",
    success: null,
    tool,
    type: "dynamicToolCall",
  };
}

function getDynamicToolCallOutputText(
  toolName: string,
  eventData: {
  error?: { message?: string } | null;
  result?: { content?: string; detailedContent?: string } | null;
},
) {
  if (toolName === COPILOT_TASK_TOOL_NAME) {
    return eventData.result?.content
      ?? eventData.result?.detailedContent
      ?? eventData.error?.message
      ?? null;
  }

  return eventData.result?.detailedContent
    ?? eventData.result?.content
    ?? eventData.error?.message
    ?? null;
}

function makeDynamicToolCallContentItems(text: string | null): DynamicToolCallOutputContentItem[] | null {
  const trimmedText = text?.trim() ?? "";
  if (!trimmedText) {
    return null;
  }

  return [{
    text: trimmedText,
    type: "inputText",
  }];
}

function createEmptyThread(sessionId: string, projectRoot: string, metadata: SessionMetadata | null = null): Thread {
  const createdAt = metadata ? toUnixSeconds(metadata.startTime) : Math.floor(Date.now() / 1000);
  const updatedAt = metadata ? toUnixSeconds(metadata.modifiedTime) : createdAt;
  return {
    agentNickname: null,
    agentRole: null,
    cliVersion: "copilot-sdk",
    createdAt,
    cwd: metadata?.context?.cwd ?? projectRoot,
    ephemeral: false,
    forkedFromId: null,
    gitInfo: null,
    id: sessionId,
    modelProvider: "copilot",
    name: metadata?.summary ?? null,
    path: null,
    preview: metadata?.summary ?? sessionId,
    sessionId,
    source: { custom: "copilot-sdk" },
    status: { type: "idle" },
    threadSource: null,
    turns: [],
    updatedAt,
  };
}

function getLastTurn(thread: Thread) {
  return thread.turns.at(-1) ?? null;
}

function getActiveTurn(state: CopilotThreadState) {
  if (state.currentTurnId) {
    return state.thread.turns.find((entry) => entry.id === state.currentTurnId) ?? null;
  }

  const turn = getLastTurn(state.thread);
  return turn?.status === "inProgress" ? turn : null;
}

function findItem<TType extends ThreadItem["type"]>(turn: Turn, type: TType): Extract<ThreadItem, { type: TType }> | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item.type === type) {
      return item as Extract<ThreadItem, { type: TType }>;
    }
  }

  return null;
}

function findItemById<TType extends ThreadItem["type"]>(
  turn: Turn,
  type: TType,
  itemId: string,
): Extract<ThreadItem, { type: TType }> | null {
  const item = turn.items.find((entry) => entry.id === itemId && entry.type === type);
  return item ? item as Extract<ThreadItem, { type: TType }> : null;
}

function ensureTurn(thread: Thread, turnId: string, timestampSeconds: number) {
  let turn = thread.turns.find((entry) => entry.id === turnId) ?? null;
  if (turn) {
    return turn;
  }

  turn = {
    completedAt: null,
    durationMs: null,
    error: null,
    id: turnId,
    items: [],
    itemsView: "full",
    startedAt: timestampSeconds,
    status: "inProgress",
  };
  thread.turns.push(turn);
  thread.status = { activeFlags: [], type: "active" };
  thread.updatedAt = timestampSeconds;
  return turn;
}

function setThreadStatus(thread: Thread, type: ThreadStatus["type"], flags: ThreadActiveFlag[] = []) {
  if (type === "active") {
    thread.status = {
      activeFlags: [...flags],
      type,
    };
    return;
  }

  thread.status = { type };
}

function buildCommandText(toolName: string, argumentsValue: unknown) {
  const args = asRecord(argumentsValue);
  if (!args) {
    return toolName;
  }

  const command = asString(args.command);
  if (command) {
    return buildSyntheticToolCommand(toolName, command);
  }

  const commands = asStringArray(args.command);
  if (commands.length) {
    return buildSyntheticToolCommand(toolName, commands.join(" "));
  }

  const fullCommandText = asString(args.fullCommandText);
  if (fullCommandText) {
    return buildSyntheticToolCommand(toolName, fullCommandText);
  }

  const prompt = asString(args.prompt);
  if (prompt) {
    return `${toolName} ${prompt}`;
  }

  return `${toolName} ${JSON.stringify(args)}`.trim();
}

function buildSyntheticToolCommand(toolName: string, command: string) {
  if (!/^powershell$/i.test(toolName)) {
    return command;
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand || /^(?:powershell|pwsh)(?:\.exe)?\b/i.test(trimmedCommand)) {
    return trimmedCommand;
  }

  return `powershell -Command ${JSON.stringify(trimmedCommand)}`;
}

function eventTimestampSeconds(event: SessionEvent) {
  return toUnixSeconds(event.timestamp);
}

function getEventAgentId(event: SessionEvent) {
  return asString(asRecord(event)?.agentId)?.trim() ?? null;
}

function isSyntheticSkillUserMessage(event: Extract<SessionEvent, { type: "user.message" }>) {
  return (asString(asRecord(event.data)?.source)?.trim() ?? "").startsWith("skill-");
}

function isDynamicCopilotTool(toolName: string) {
  return toolName === WORKBENCH_QUESTIONNAIRE_TOOL_NAME
    || toolName === COPILOT_SKILL_TOOL_NAME
    || toolName === COPILOT_TASK_TOOL_NAME;
}

function ensureDynamicToolArgumentsRecord(item: DynamicToolCallItem) {
  const record = asRecord(item.arguments);
  if (record) {
    return record;
  }

  const nextRecord: Record<string, unknown> = {};
  item.arguments = nextRecord as DynamicToolCallItem["arguments"];
  return nextRecord;
}

function updateDynamicToolMetadata(
  item: DynamicToolCallItem,
  updates: Record<string, unknown>,
) {
  const argumentsRecord = ensureDynamicToolArgumentsRecord(item);
  const currentMetadata = asRecord(argumentsRecord[COPILOT_DYNAMIC_TOOL_METADATA_KEY]) ?? {};
  argumentsRecord[COPILOT_DYNAMIC_TOOL_METADATA_KEY] = {
    ...currentMetadata,
    ...updates,
  };
}

function findToolCallTarget(state: CopilotThreadState, toolCallId: string) {
  const target = state.toolCallItems.get(toolCallId);
  const turn = target ? state.thread.turns.find((entry) => entry.id === target.turnId) ?? null : null;
  const item = turn?.items.find((entry) => entry.id === target?.itemId) ?? null;
  return target && turn && item
    ? {
      item,
      turn,
    }
    : null;
}

function findMostRecentDynamicToolCallItem(
  state: CopilotThreadState,
  match: (item: DynamicToolCallItem) => boolean,
) {
  for (let turnIndex = state.thread.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = state.thread.turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      if (item.type === "dynamicToolCall" && match(item)) {
        return item;
      }
    }
  }

  return null;
}

export function createThreadState(threadId: string, metadata: SessionMetadata | null, projectRoot: string): CopilotThreadState {
  return {
    currentTurnId: null,
    metadata,
    pendingUserInputs: [],
    sessionId: threadId,
    thread: createEmptyThread(threadId, projectRoot, metadata),
    toolCallItems: new Map(),
  };
}

export function metadataToThread(metadata: SessionMetadata | null, existing: Thread | null, projectRoot: string) {
  const thread = existing ?? createEmptyThread(metadata?.sessionId ?? randomUUID(), projectRoot, metadata);
  if (!metadata) {
    return thread;
  }

  thread.createdAt = toUnixSeconds(metadata.startTime);
  thread.updatedAt = toUnixSeconds(metadata.modifiedTime);
  thread.cwd = metadata.context?.cwd ?? thread.cwd;
  thread.name = metadata.summary ?? thread.name;
  thread.preview = metadata.summary ?? thread.preview;
  return thread;
}

export function applyCopilotEvent(
  state: CopilotThreadState,
  event: SessionEvent,
  emitNotifications: boolean,
  onNotification: (notification: JsonRpcNotification) => void,
) {
  const timestampSeconds = eventTimestampSeconds(event);
  switch (event.type) {
    case "session.title_changed": {
      state.thread.name = event.data.title;
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "thread/name/updated",
          params: {
            threadId: state.thread.id,
            threadName: event.data.title,
          },
        });
      }
      return;
    }
    case "session.context_changed": {
      state.thread.cwd = event.data.cwd;
      state.thread.updatedAt = timestampSeconds;
      return;
    }
    case "session.error": {
      state.currentTurnId = null;
      setThreadStatus(state.thread, "systemError");
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "thread/status/changed",
          params: {
            status: state.thread.status,
            threadId: state.thread.id,
          },
        });
      }
      return;
    }
    case "user.message": {
      if (isSyntheticSkillUserMessage(event)) {
        return;
      }

      const content = event.data.content.trim();
      if (!content) {
        return;
      }

      const input: UserInput[] = [{
        text: content,
        text_elements: [],
        type: "text",
      }];

      const activeTurn = getActiveTurn(state);
      if (activeTurn) {
        activeTurn.items.push(makeUserMessageItem(input));
        state.thread.preview = content;
        state.thread.updatedAt = timestampSeconds;
        return;
      }

      state.pendingUserInputs.push(input);
      state.thread.preview = previewFromUserInputs(state.pendingUserInputs, state.thread.preview || state.thread.id);
      state.thread.updatedAt = timestampSeconds;
      return;
    }
    case "assistant.turn_start": {
      const turn = ensureTurn(state.thread, buildTurnId(event.data.turnId, event.data.interactionId), timestampSeconds);
      turn.status = "inProgress";
      turn.completedAt = null;
      turn.durationMs = null;
      state.currentTurnId = turn.id;
      if (state.pendingUserInputs.length) {
        for (const input of state.pendingUserInputs) {
          turn.items.push(makeUserMessageItem(input));
        }
        state.pendingUserInputs = [];
      }
      setThreadStatus(state.thread, "active");
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "thread/status/changed",
          params: {
            status: state.thread.status,
            threadId: state.thread.id,
          },
        });
        onNotification({
          method: "turn/started",
          params: {
            threadId: state.thread.id,
            turn: structuredClone(turn),
          },
        });
      }
      return;
    }
    case "assistant.reasoning_delta": {
      if (getEventAgentId(event)) {
        return;
      }

      const turn = getActiveTurn(state);
      if (!turn) {
        return;
      }

      const itemId = `reasoning:${event.data.reasoningId}`;
      let item = findItemById(turn, "reasoning", itemId);
      if (!item) {
        item = makeReasoningItem(itemId);
        turn.items.push(item);
        if (emitNotifications) {
          onNotification({
            method: "item/started",
            params: {
              item: structuredClone(item),
              threadId: state.thread.id,
              turnId: turn.id,
            },
          });
        }
      }

      if (!item.content.length) {
        item.content.push("");
      }
      item.content[0] = `${item.content[0] ?? ""}${event.data.deltaContent}`;
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "item/reasoning/textDelta",
          params: {
            contentIndex: 0,
            delta: event.data.deltaContent,
            itemId: item.id,
            threadId: state.thread.id,
            turnId: turn.id,
          },
        });
      }
      return;
    }
    case "assistant.reasoning": {
      if (getEventAgentId(event)) {
        return;
      }

      const turn = getActiveTurn(state);
      if (!turn) {
        return;
      }

      const itemId = `reasoning:${event.data.reasoningId}`;
      let item = findItemById(turn, "reasoning", itemId);
      if (!item) {
        item = makeReasoningItem(itemId);
        turn.items.push(item);
      }
      item.content = [event.data.content];
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "item/completed",
          params: {
            item: structuredClone(item),
            threadId: state.thread.id,
            turnId: turn.id,
          },
        });
      }
      return;
    }
    case "assistant.message_delta": {
      const parentToolCallId = asString(asRecord(event.data)?.parentToolCallId);
      if (parentToolCallId) {
        const target = findToolCallTarget(state, parentToolCallId);
        if (target?.item.type === "dynamicToolCall" && target.item.tool === COPILOT_TASK_TOOL_NAME) {
          updateDynamicToolMetadata(target.item, {
            kind: "task",
            latestMessage: `${asString(asRecord(ensureDynamicToolArgumentsRecord(target.item)[COPILOT_DYNAMIC_TOOL_METADATA_KEY])?.latestMessage) ?? ""}${event.data.deltaContent}`,
          });
          state.thread.updatedAt = timestampSeconds;
          return;
        }
      }

      if (getEventAgentId(event)) {
        return;
      }

      const turn = getActiveTurn(state);
      if (!turn) {
        return;
      }

      const itemId = `agent:${event.data.messageId}`;
      let item = findItemById(turn, "agentMessage", itemId);
      if (!item) {
        item = makeAgentMessageItem(itemId);
        turn.items.push(item);
        if (emitNotifications) {
          onNotification({
            method: "item/started",
            params: {
              item: structuredClone(item),
              threadId: state.thread.id,
              turnId: turn.id,
            },
          });
        }
      }

      item.text = `${item.text}${event.data.deltaContent}`;
      item.phase = "commentary";
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "item/agentMessage/delta",
          params: {
            delta: event.data.deltaContent,
            itemId: item.id,
            threadId: state.thread.id,
            turnId: turn.id,
          },
        });
      }
      return;
    }
    case "assistant.message": {
      const parentToolCallId = asString(asRecord(event.data)?.parentToolCallId);
      if (parentToolCallId) {
        const target = findToolCallTarget(state, parentToolCallId);
        if (target?.item.type === "dynamicToolCall" && target.item.tool === COPILOT_TASK_TOOL_NAME) {
          updateDynamicToolMetadata(target.item, {
            kind: "task",
            latestMessage: event.data.content,
          });
          state.thread.updatedAt = timestampSeconds;
          if (emitNotifications) {
            onNotification({
              method: "item/completed",
              params: {
                item: structuredClone(target.item),
                threadId: state.thread.id,
                turnId: target.turn.id,
              },
            });
          }
          return;
        }
      }

      if (getEventAgentId(event)) {
        return;
      }

      const turn = getActiveTurn(state);
      if (!turn) {
        return;
      }

      const itemId = `agent:${event.data.messageId}`;
      let item = findItemById(turn, "agentMessage", itemId);
      if (!item) {
        item = makeAgentMessageItem(itemId);
        turn.items.push(item);
      }

      const isFinalMessage = isLikelyFinalAssistantMessage(event.data);
      item.text = event.data.content;
      item.phase = isFinalMessage ? "final_answer" : "commentary";

      const reasoningText = asString(asRecord(event.data)?.reasoningText)?.trim();
      const reasoningItem = reasoningText ? upsertMessageReasoningItem(turn, item, reasoningText) : null;
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        if (reasoningItem) {
          onNotification({
            method: "item/completed",
            params: {
              item: structuredClone(reasoningItem),
              threadId: state.thread.id,
              turnId: turn.id,
            },
          });
        }

        onNotification({
          method: "item/completed",
          params: {
            item: structuredClone(item),
            threadId: state.thread.id,
            turnId: turn.id,
          },
        });
      }
      return;
    }
    case "tool.execution_start": {
      const turn = getActiveTurn(state);
      if (!turn) {
        return;
      }

      const itemId = `tool:${event.data.toolCallId}`;
      const item = isDynamicCopilotTool(event.data.toolName)
        ? makeDynamicToolCallItem(itemId, event.data.toolName, event.data.arguments)
        : makeCommandExecutionItem(itemId, buildCommandText(event.data.toolName, event.data.arguments), state.thread.cwd);
      if (item.type === "dynamicToolCall") {
        if (event.data.toolName === COPILOT_SKILL_TOOL_NAME) {
          updateDynamicToolMetadata(item, { kind: "skill" });
        } else if (event.data.toolName === COPILOT_TASK_TOOL_NAME) {
          updateDynamicToolMetadata(item, { kind: "task" });
        }
      }
      turn.items.push(item);
      state.toolCallItems.set(event.data.toolCallId, {
        itemId,
        turnId: turn.id,
      });
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "item/started",
          params: {
            item: structuredClone(item),
            threadId: state.thread.id,
            turnId: turn.id,
          },
        });
      }
      return;
    }
    case "subagent.started": {
      const data = asRecord(event.data);
      const toolCallId = asString(data?.toolCallId);
      if (!toolCallId) {
        return;
      }

      const target = findToolCallTarget(state, toolCallId);
      if (!target || target.item.type !== "dynamicToolCall" || target.item.tool !== COPILOT_TASK_TOOL_NAME) {
        return;
      }

      updateDynamicToolMetadata(target.item, {
        agentDescription: asString(data?.agentDescription),
        agentDisplayName: asString(data?.agentDisplayName),
        agentId: getEventAgentId(event),
        agentName: asString(data?.agentName),
        kind: "task",
      });
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "item/completed",
          params: {
            item: structuredClone(target.item),
            threadId: state.thread.id,
            turnId: target.turn.id,
          },
        });
      }
      return;
    }
    case "subagent.completed": {
      const data = asRecord(event.data);
      const toolCallId = asString(data?.toolCallId);
      if (!toolCallId) {
        return;
      }

      const target = findToolCallTarget(state, toolCallId);
      if (!target || target.item.type !== "dynamicToolCall" || target.item.tool !== COPILOT_TASK_TOOL_NAME) {
        return;
      }

      updateDynamicToolMetadata(target.item, {
        agentDisplayName: asString(data?.agentDisplayName),
        agentName: asString(data?.agentName),
        kind: "task",
      });
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "item/completed",
          params: {
            item: structuredClone(target.item),
            threadId: state.thread.id,
            turnId: target.turn.id,
          },
        });
      }
      return;
    }
    case "skill.invoked": {
      const data = asRecord(event.data);
      const skillName = asString(data?.name)?.trim() ?? "";
      if (!skillName) {
        return;
      }

      const item = findMostRecentDynamicToolCallItem(state, (candidate) => (
        candidate.tool === COPILOT_SKILL_TOOL_NAME
        && (asString(asRecord(candidate.arguments)?.skill)?.trim() ?? "") === skillName
      ));
      if (!item) {
        return;
      }

      updateDynamicToolMetadata(item, {
        kind: "skill",
        skillContent: asString(data?.content),
        skillDescription: asString(data?.description),
        skillName,
        skillPath: asString(data?.path),
      });
      state.thread.updatedAt = timestampSeconds;
      return;
    }
    case "tool.execution_partial_result": {
      const target = findToolCallTarget(state, event.data.toolCallId);
      if (!target || target.item.type !== "commandExecution") {
        return;
      }

      target.item.aggregatedOutput = appendCommandOutputDelta(target.item.aggregatedOutput, event.data.partialOutput);
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "item/commandExecution/outputDelta",
          params: {
            delta: event.data.partialOutput,
            itemId: target.item.id,
            threadId: state.thread.id,
            turnId: target.turn.id,
          },
        });
      }
      return;
    }
    case "tool.execution_complete": {
      const target = findToolCallTarget(state, event.data.toolCallId);
      if (!target) {
        return;
      }

      if (target.item.type === "commandExecution") {
        target.item.status = event.data.success ? "completed" : "failed";
        target.item.exitCode = event.data.success ? 0 : 1;
        target.item.durationMs = typeof event.data.toolTelemetry?.durationMs === "number"
          ? event.data.toolTelemetry.durationMs
          : target.item.durationMs;
        if (event.data.result?.detailedContent) {
          target.item.aggregatedOutput = compactCommandOutput(event.data.result.detailedContent);
        } else if (event.data.result?.content) {
          target.item.aggregatedOutput = compactCommandOutput(event.data.result.content);
        } else if (event.data.error?.message) {
          target.item.aggregatedOutput = compactCommandOutput(event.data.error.message);
        }
      } else if (target.item.type === "dynamicToolCall") {
        target.item.status = event.data.success ? "completed" : "failed";
        target.item.success = event.data.success;
        target.item.durationMs = typeof event.data.toolTelemetry?.durationMs === "number"
          ? event.data.toolTelemetry.durationMs
          : target.item.durationMs;
        target.item.contentItems = makeDynamicToolCallContentItems(getDynamicToolCallOutputText(target.item.tool, event.data));
      } else {
        return;
      }

      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "item/completed",
          params: {
            item: structuredClone(target.item),
            threadId: state.thread.id,
            turnId: target.turn.id,
          },
        });
      }
      return;
    }
    case "assistant.turn_end": {
      const turn = getActiveTurn(state);
      if (!turn) {
        return;
      }

      if (turn.status !== "inProgress") {
        return;
      }

      turn.completedAt = timestampSeconds;
      turn.durationMs = toTurnDurationMs(turn);
      turn.status = "completed";
      state.currentTurnId = null;
      setThreadStatus(state.thread, "idle");
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "turn/completed",
          params: {
            threadId: state.thread.id,
            turn: structuredClone(turn),
          },
        });
        onNotification({
          method: "thread/status/changed",
          params: {
            status: state.thread.status,
            threadId: state.thread.id,
          },
        });
      }
      return;
    }
    case "abort": {
      const turn = getActiveTurn(state);
      if (!turn || turn.status !== "inProgress") {
        return;
      }

      turn.completedAt = timestampSeconds;
      turn.durationMs = toTurnDurationMs(turn);
      turn.status = "completed";
      state.currentTurnId = null;
      state.toolCallItems.clear();
      setThreadStatus(state.thread, "idle");
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "turn/completed",
          params: {
            threadId: state.thread.id,
            turn: structuredClone(turn),
          },
        });
        onNotification({
          method: "thread/status/changed",
          params: {
            status: state.thread.status,
            threadId: state.thread.id,
          },
        });
      }
      return;
    }
    case "session.idle": {
      const turn = getActiveTurn(state);
      if (!turn || turn.status !== "inProgress") {
        return;
      }

      turn.completedAt = timestampSeconds;
      turn.durationMs = toTurnDurationMs(turn);
      turn.status = "completed";
      state.currentTurnId = null;
      state.toolCallItems.clear();
      setThreadStatus(state.thread, "idle");
      state.thread.updatedAt = timestampSeconds;
      if (emitNotifications) {
        onNotification({
          method: "turn/completed",
          params: {
            threadId: state.thread.id,
            turn: structuredClone(turn),
          },
        });
        onNotification({
          method: "thread/status/changed",
          params: {
            status: state.thread.status,
            threadId: state.thread.id,
          },
        });
      }
      return;
    }
  }
}
