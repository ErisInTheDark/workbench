/*
 * Exports:
 * - OpenCodeLiveThreadState/createOpenCodeLiveThreadState/applyOpenCodeLiveEvent: maintain v2 OpenCode in-turn streaming state and emit Codex-shaped notifications. Keywords: opencode, v2, live events, streaming.
 */
import type {
  Part,
  Prompt,
  ToolFileContent,
  ToolTextContent,
  V2Event,
} from "@opencode-ai/sdk/v2";

import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput";
import type { JsonValue } from "../lib/codex/generated/app-server/serde_json/JsonValue";
import type { JsonRpcNotification } from "./bridge-types";

type OnNotification = (notification: JsonRpcNotification) => void;

type LiveSessionState = {
  currentTurnId: string | null;
  messageRoleById: Map<string, "assistant" | "user">;
  partById: Map<string, {
    kind: Part["type"];
    messageId: string;
  }>;
  startedItems: Set<string>;
  textDeltaSourceByItemId: Map<string, "messagePart" | "sessionNext">;
  toolInputTextByCallId: Map<string, string>;
};

export type OpenCodeLiveThreadState = {
  sessions: Map<string, LiveSessionState>;
};

export function createOpenCodeLiveThreadState(): OpenCodeLiveThreadState {
  return {
    sessions: new Map(),
  };
}

function liveSession(state: OpenCodeLiveThreadState, sessionId: string) {
  let session = state.sessions.get(sessionId);
  if (!session) {
    session = {
      currentTurnId: null,
      messageRoleById: new Map(),
      partById: new Map(),
      startedItems: new Set(),
      textDeltaSourceByItemId: new Map(),
      toolInputTextByCallId: new Map(),
    };
    state.sessions.set(sessionId, session);
  }
  return session;
}

function toUnixSeconds(value: number | null | undefined) {
  if (!value) {
    return Math.floor(Date.now() / 1000);
  }

  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function turnIdFromMessage(sessionId: string, messageId: string) {
  return `opencode:turn:${sessionId}:${messageId}`;
}

function userItemId(messageId: string) {
  return `opencode:user:${messageId}`;
}

function agentItemId(messageId: string, textId: string) {
  return `opencode:agent:${messageId}:${textId}`;
}

function reasoningItemId(reasoningId: string) {
  return `opencode:reasoning:${reasoningId}`;
}

function toolItemId(callId: string) {
  return `opencode:tool:${callId}`;
}

function jsonLike(value: Record<string, unknown>): JsonValue {
  return value as JsonValue;
}

function promptToUserInput(prompt: Prompt): UserInput[] {
  const input: UserInput[] = [];
  if (prompt.text.trim()) {
    input.push({
      text: prompt.text,
      text_elements: [],
      type: "text",
    });
  }

  for (const file of prompt.files ?? []) {
    input.push({
      type: "mention",
      name: file.name ?? file.uri,
      path: file.uri,
    });
  }

  for (const agent of prompt.agents ?? []) {
    input.push({
      type: "mention",
      name: agent.name,
      path: agent.name,
    });
  }

  return input;
}

function ensureTurn(
  live: LiveSessionState,
  sessionId: string,
  messageId: string,
  timestamp: number,
  onNotification: OnNotification,
  items: ThreadItem[] = [],
) {
  const turnId = turnIdFromMessage(sessionId, messageId);
  if (live.currentTurnId === turnId) {
    return turnId;
  }

  live.currentTurnId = turnId;
  const turn: Turn = {
    completedAt: null,
    durationMs: null,
    error: null,
    id: turnId,
    items,
    itemsView: "full",
    startedAt: toUnixSeconds(timestamp),
    status: "inProgress",
  };
  onNotification({
    method: "turn/started",
    params: {
      threadId: sessionId,
      turn,
    },
  });
  return turnId;
}

function ensureItemStarted(
  live: LiveSessionState,
  threadId: string,
  turnId: string,
  item: ThreadItem,
  onNotification: OnNotification,
) {
  const key = `${turnId}:${item.id}`;
  if (live.startedItems.has(key)) {
    return;
  }

  live.startedItems.add(key);
  onNotification({
    method: "item/started",
    params: {
      item,
      threadId,
      turnId,
    },
  });
}

function textContent(content: Array<ToolTextContent | ToolFileContent>) {
  return content.map((entry) => (
    entry.type === "text"
      ? entry.text
      : `${entry.name ?? entry.uri} (${entry.mime})`
  )).filter((entry) => entry.trim()).join("\n\n");
}

function toolArguments(input: unknown, fallbackText: string): JsonValue {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as JsonValue;
  }
  return jsonLike({ input: typeof input === "string" ? input : fallbackText });
}

function createToolItem(
  callId: string,
  tool: string,
  status: Extract<ThreadItem, { type: "dynamicToolCall" }>["status"],
  input: unknown,
  outputText: string,
  success: boolean | null,
): Extract<ThreadItem, { type: "dynamicToolCall" }> {
  return {
    arguments: toolArguments(input, ""),
    contentItems: outputText ? [{ text: outputText, type: "inputText" }] : null,
    durationMs: null,
    id: toolItemId(callId),
    namespace: "opencode",
    status,
    success,
    tool,
    type: "dynamicToolCall",
  };
}

function durationMs(start: number | null | undefined, end: number | null | undefined) {
  return typeof start === "number" && typeof end === "number"
    ? Math.max(0, Math.round((end - start) * 1000))
    : null;
}

function createToolItemFromPart(part: Extract<Part, { type: "tool" }>): Extract<ThreadItem, { type: "dynamicToolCall" }> {
  const state = part.state;
  const outputText = state.status === "completed"
    ? state.output
    : state.status === "error"
      ? state.error
      : state.status === "pending"
        ? state.raw
        : state.title ?? "";
  const start = "time" in state ? state.time.start : undefined;
  const end = "time" in state && "end" in state.time ? state.time.end : undefined;

  return {
    arguments: toolArguments(state.input, ""),
    contentItems: outputText ? [{ text: outputText, type: "inputText" }] : null,
    durationMs: durationMs(start, end),
    id: toolItemId(part.id),
    namespace: "opencode",
    status: state.status === "completed" ? "completed" : state.status === "error" ? "failed" : "inProgress",
    success: state.status === "completed" ? true : state.status === "error" ? false : null,
    tool: part.tool,
    type: "dynamicToolCall",
  };
}

function activeTurnId(live: LiveSessionState, sessionId: string, fallbackMessageId: string, timestamp: number, onNotification: OnNotification) {
  return live.currentTurnId ?? ensureTurn(live, sessionId, fallbackMessageId, timestamp, onNotification);
}

function itemIdForPart(messageId: string, partId: string, kind: Part["type"]) {
  return kind === "reasoning"
    ? reasoningItemId(partId)
    : agentItemId(messageId, partId);
}

function claimTextDeltaSource(
  live: LiveSessionState,
  itemId: string,
  source: "messagePart" | "sessionNext",
) {
  const existing = live.textDeltaSourceByItemId.get(itemId);
  if (existing && existing !== source) {
    return false;
  }

  live.textDeltaSourceByItemId.set(itemId, source);
  return true;
}

export function applyOpenCodeLiveEvent(
  state: OpenCodeLiveThreadState,
  event: V2Event,
  onNotification: OnNotification,
) {
  switch (event.type) {
    case "message.updated": {
      const live = liveSession(state, event.data.sessionID);
      live.messageRoleById.set(event.data.info.id, event.data.info.role);
      return;
    }
    case "message.part.updated": {
      const live = liveSession(state, event.data.sessionID);
      const part = event.data.part;
      live.partById.set(part.id, {
        kind: part.type,
        messageId: part.messageID,
      });
      const turnId = activeTurnId(live, event.data.sessionID, part.messageID, event.data.time, onNotification);

      switch (part.type) {
        case "reasoning": {
          const item: Extract<ThreadItem, { type: "reasoning" }> = {
            content: [],
            id: reasoningItemId(part.id),
            summary: [],
            type: "reasoning",
          };
          ensureItemStarted(live, event.data.sessionID, turnId, item, onNotification);
          if (part.time.end) {
            const text = part.text.trim();
            onNotification({
              method: "item/completed",
              params: {
                item: {
                  ...item,
                  content: text ? [text] : [],
                  summary: text ? [text] : [],
                },
                threadId: event.data.sessionID,
                turnId,
              },
            });
          }
          return;
        }
        case "text": {
          if (live.messageRoleById.get(part.messageID) !== "assistant") {
            return;
          }

          const itemId = agentItemId(part.messageID, part.id);
          const item: Extract<ThreadItem, { type: "agentMessage" }> = {
            id: itemId,
            memoryCitation: null,
            phase: "commentary",
            text: "",
            type: "agentMessage",
          };
          ensureItemStarted(live, event.data.sessionID, turnId, item, onNotification);
          if (part.time?.end) {
            onNotification({
              method: "item/completed",
              params: {
                item: {
                  ...item,
                  phase: "final_answer",
                  text: part.text,
                },
                threadId: event.data.sessionID,
                turnId,
              },
            });
          }
          return;
        }
        case "tool": {
          const item = createToolItemFromPart(part);
          ensureItemStarted(live, event.data.sessionID, turnId, item, onNotification);
          onNotification({
            method: "item/completed",
            params: {
              item,
              threadId: event.data.sessionID,
              turnId,
            },
          });
          return;
        }
        default:
          return;
      }
    }
    case "session.next.prompt.admitted":
    case "session.next.prompted": {
      const live = liveSession(state, event.data.sessionID);
      const userItem: Extract<ThreadItem, { type: "userMessage" }> = {
        content: promptToUserInput(event.data.prompt),
        id: userItemId(event.data.messageID),
        type: "userMessage",
      };
      ensureTurn(live, event.data.sessionID, event.data.messageID, event.data.timestamp, onNotification, [userItem]);
      onNotification({
        method: "thread/status/changed",
        params: {
          status: { activeFlags: [], type: "active" },
          threadId: event.data.sessionID,
        },
      });
      return;
    }
    case "session.next.text.started": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      ensureItemStarted(live, event.data.sessionID, turnId, {
        id: agentItemId(event.data.assistantMessageID, event.data.textID),
        memoryCitation: null,
        phase: "commentary",
        text: "",
        type: "agentMessage",
      }, onNotification);
      return;
    }
    case "session.next.text.delta": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      const itemId = agentItemId(event.data.assistantMessageID, event.data.textID);
      if (!claimTextDeltaSource(live, itemId, "sessionNext")) {
        return;
      }
      ensureItemStarted(live, event.data.sessionID, turnId, {
        id: itemId,
        memoryCitation: null,
        phase: "commentary",
        text: "",
        type: "agentMessage",
      }, onNotification);
      onNotification({
        method: "item/agentMessage/delta",
        params: {
          delta: event.data.delta,
          itemId,
          threadId: event.data.sessionID,
          turnId,
        },
      });
      return;
    }
    case "message.part.delta": {
      if (event.data.field !== "text") {
        return;
      }

      const live = liveSession(state, event.data.sessionID);
      const part = live.partById.get(event.data.partID);
      const kind = part?.kind ?? "text";
      if (kind !== "text" && kind !== "reasoning") {
        return;
      }

      const messageId = part?.messageId ?? event.data.messageID;
      const turnId = activeTurnId(live, event.data.sessionID, messageId, Date.now(), onNotification);
      const itemId = itemIdForPart(messageId, event.data.partID, kind);
      if (!claimTextDeltaSource(live, itemId, "messagePart")) {
        return;
      }

      if (kind === "reasoning") {
        ensureItemStarted(live, event.data.sessionID, turnId, {
          content: [],
          id: itemId,
          summary: [],
          type: "reasoning",
        }, onNotification);
        onNotification({
          method: "item/reasoning/textDelta",
          params: {
            contentIndex: 0,
            delta: event.data.delta,
            itemId,
            threadId: event.data.sessionID,
            turnId,
          },
        });
        return;
      }

      ensureItemStarted(live, event.data.sessionID, turnId, {
        id: itemId,
        memoryCitation: null,
        phase: "commentary",
        text: "",
        type: "agentMessage",
      }, onNotification);
      onNotification({
        method: "item/agentMessage/delta",
        params: {
          delta: event.data.delta,
          itemId,
          threadId: event.data.sessionID,
          turnId,
        },
      });
      return;
    }
    case "session.next.text.ended": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      onNotification({
        method: "item/completed",
        params: {
          item: {
            id: agentItemId(event.data.assistantMessageID, event.data.textID),
            memoryCitation: null,
            phase: "final_answer",
            text: event.data.text,
            type: "agentMessage",
          },
          threadId: event.data.sessionID,
          turnId,
        },
      });
      return;
    }
    case "session.next.reasoning.started": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      ensureItemStarted(live, event.data.sessionID, turnId, {
        content: [],
        id: reasoningItemId(event.data.reasoningID),
        summary: [],
        type: "reasoning",
      }, onNotification);
      return;
    }
    case "session.next.reasoning.delta": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      const itemId = reasoningItemId(event.data.reasoningID);
      ensureItemStarted(live, event.data.sessionID, turnId, {
        content: [],
        id: itemId,
        summary: [],
        type: "reasoning",
      }, onNotification);
      onNotification({
        method: "item/reasoning/textDelta",
        params: {
          contentIndex: 0,
          delta: event.data.delta,
          itemId,
          threadId: event.data.sessionID,
          turnId,
        },
      });
      return;
    }
    case "session.next.reasoning.ended": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      onNotification({
        method: "item/completed",
        params: {
          item: {
            content: event.data.text ? [event.data.text] : [],
            id: reasoningItemId(event.data.reasoningID),
            summary: [],
            type: "reasoning",
          },
          threadId: event.data.sessionID,
          turnId,
        },
      });
      return;
    }
    case "session.next.tool.input.started":
    case "session.next.tool.called": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      const tool = event.type === "session.next.tool.called" ? event.data.tool : event.data.name;
      const input = event.type === "session.next.tool.called" ? event.data.input : {};
      ensureItemStarted(live, event.data.sessionID, turnId, createToolItem(event.data.callID, tool, "inProgress", input, "", null), onNotification);
      return;
    }
    case "session.next.tool.input.delta": {
      const live = liveSession(state, event.data.sessionID);
      live.toolInputTextByCallId.set(event.data.callID, `${live.toolInputTextByCallId.get(event.data.callID) ?? ""}${event.data.delta}`);
      return;
    }
    case "session.next.tool.input.ended": {
      const live = liveSession(state, event.data.sessionID);
      live.toolInputTextByCallId.set(event.data.callID, event.data.text);
      return;
    }
    case "session.next.tool.progress": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      const outputText = textContent(event.data.content);
      onNotification({
        method: "item/completed",
        params: {
          item: createToolItem(event.data.callID, event.data.callID, "inProgress", event.data.structured, outputText, null),
          threadId: event.data.sessionID,
          turnId,
        },
      });
      return;
    }
    case "session.next.tool.success": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      onNotification({
        method: "item/completed",
        params: {
          item: createToolItem(event.data.callID, event.data.callID, "completed", event.data.structured, textContent(event.data.content), true),
          threadId: event.data.sessionID,
          turnId,
        },
      });
      return;
    }
    case "session.next.tool.failed": {
      const live = liveSession(state, event.data.sessionID);
      const turnId = activeTurnId(live, event.data.sessionID, event.data.assistantMessageID, event.data.timestamp, onNotification);
      onNotification({
        method: "item/completed",
        params: {
          item: createToolItem(event.data.callID, event.data.callID, "failed", {}, event.data.error.message, false),
          threadId: event.data.sessionID,
          turnId,
        },
      });
      return;
    }
    case "session.idle": {
      const live = liveSession(state, event.data.sessionID);
      live.currentTurnId = null;
      return;
    }
    default:
      return;
  }
}
