/*
 * Exports:
 * - parseThreadRenderInput: parse canonical thread payloads/items without rewriting them, while adapting shorthand lab fixtures into renderable thread data.
 */

import type { CommandAction } from "workbench-shared/workbench/thread/workbench-thread-items";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import type { ThreadItem, JsonValue } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import { toThreadPayload } from "workbench-shared/codex/thread-adapter";
import type { ThreadPayload, WorkbenchBrowseResultEntry, WorkbenchHarness } from "workbench-shared/types";
import { z } from "zod";
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";

const LabThreadIdSchema = z.string().brand<"WorkbenchThreadId">();
const LabDraftIdSchema = z.string().brand<"DraftId">();

type JsonObject = { [key: string]: JsonValue | undefined };
type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;
type AgentMessageItem = Extract<ThreadItem, { type: "agentMessage" }>;
type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;
type UserMessageItem = Extract<ThreadItem, { type: "userMessage" }>;
type WebSearchItem = Extract<ThreadItem, { type: "webSearch" }>;

function isJsonObject(value: JsonValue): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: JsonObject, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNullableString(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: JsonObject, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(record: JsonObject, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeCommandAction(value: JsonValue): CommandAction | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const command = readString(value, "command");
  const type = readString(value, "type");
  if (!command || !type) {
    return null;
  }

  if (type === "unknown") {
    return { type, command };
  }
  if (type === "read") {
    const name = readString(value, "name");
    const path = readString(value, "path");
    return name && path ? { type, command, name, path } : null;
  }
  if (type === "listFiles") {
    return { type, command, path: readNullableString(value, "path") };
  }
  if (type === "search") {
    return {
      type,
      command,
      path: readNullableString(value, "path"),
      query: readNullableString(value, "query"),
    };
  }
  return null;
}

function readCommandActions(record: JsonObject) {
  return Array.isArray(record.commandActions)
    ? record.commandActions
      .map(normalizeCommandAction)
      .filter((action): action is CommandAction => action !== null)
    : [];
}

function normalizeBrowseResultEntry(value: JsonValue): WorkbenchBrowseResultEntry | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const action = readString(value, "action");
  const actionIndex = readNumber(value, "actionIndex");
  const assetUrl = readString(value, "assetUrl");
  const detailKind = readString(value, "detailKind");
  const detailLabel = readString(value, "detailLabel");
  const detailText = readString(value, "detailText");
  const durationMs = readNumber(value, "durationMs");
  const entryKey = readString(value, "entryKey");
  const recordedAt = readNumber(value, "recordedAt");
  const session = readString(value, "session");
  const state = readString(value, "state");
  const threadId = readString(value, "threadId");
  const turnId = readString(value, "turnId");
  if (!action || actionIndex === null || !entryKey || recordedAt === null || durationMs === null || !state || !threadId || !turnId) {
    return null;
  }

  return {
    action: action as WorkbenchBrowseResultEntry["action"],
    actionIndex,
    assetUrl: assetUrl ?? null,
    commandItemId: readString(value, "commandItemId"),
    detailKind: detailKind as WorkbenchBrowseResultEntry["detailKind"],
    detailLabel,
    detailText,
    durationMs,
    entryKey,
    recordedAt,
    session: session ?? null,
    state: state as WorkbenchBrowseResultEntry["state"],
    threadId,
    turnId,
  };
}

function readBrowseResultEntries(record: JsonObject) {
  return Array.isArray(record.browseResultEntries)
    ? record.browseResultEntries
      .map(normalizeBrowseResultEntry)
      .filter((entry): entry is WorkbenchBrowseResultEntry => entry !== null)
    : [];
}

function createCommandExecutionItem(value: string | JsonObject, index: number): CommandExecutionItem {
  const record = typeof value === "string" ? null : value;
  const command = typeof value === "string" ? value : readString(value, "command") ?? "";
  const id = record ? readString(record, "id") ?? `lab-command-${index + 1}` : `lab-command-${index + 1}`;
  const status = record && readString(record, "status") === "inProgress" ? "inProgress"
    : record && readString(record, "status") === "failed" ? "failed"
      : record && readString(record, "status") === "declined" ? "declined"
        : "completed";
  const source = record && readString(record, "source");

  return {
    type: "commandExecution",
    id,
    command,
    cwd: record ? readString(record, "cwd") ?? "c:/git/web/workbench" : "c:/git/web/workbench",
    processId: record ? readString(record, "processId") : null,
    source: source === "userShell" || source === "unifiedExecStartup" || source === "unifiedExecInteraction" ? source : "agent",
    status,
    commandActions: record ? readCommandActions(record) : [],
    aggregatedOutput: record ? readString(record, "aggregatedOutput") : null,
    exitCode: record ? readNumber(record, "exitCode") : 0,
    durationMs: record ? readNumber(record, "durationMs") : null,
    pluginId: record ? readString(record, "pluginId") : null,
    scriptPath: record ? readString(record, "scriptPath") : null,
  };
}

function createUserMessageItem(record: JsonObject, index: number): UserMessageItem {
  const text = readString(record, "text");
  return {
    type: "userMessage",
    id: readString(record, "id") ?? `lab-user-${index + 1}`,
    clientId: readString(record, "clientId") ?? null,
    content: text ? [{ type: "text", text, text_elements: [] }] : [],
  };
}

function createAgentMessageItem(record: JsonObject, index: number): AgentMessageItem {
  return {
    type: "agentMessage",
    id: readString(record, "id") ?? `lab-agent-${index + 1}`,
    text: readString(record, "text") ?? "",
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
}

function createReasoningItem(record: JsonObject, index: number): ReasoningItem {
  return {
    type: "reasoning",
    id: readString(record, "id") ?? `lab-reasoning-${index + 1}`,
    summary: readStringArray(record, "summary"),
    content: readStringArray(record, "content"),
  };
}

function createWebSearchItem(record: JsonObject, index: number): WebSearchItem {
  return {
    type: "webSearch",
    id: readString(record, "id") ?? `lab-web-search-${index + 1}`,
    query: readString(record, "query") ?? "",
    action: null,
    results: null,
  };
}

function normalizeThreadItem(value: JsonValue, index: number): ThreadItem | null {
  if (typeof value === "string") {
    return createCommandExecutionItem(value, index);
  }

  if (!isJsonObject(value)) {
    return null;
  }

  const type = readString(value, "type");
  if (type === "plan") {
    return null;
  }
  if (type && readString(value, "id")) {
    return value as ThreadItem;
  }
  if ((!type || type === "commandExecution") && readString(value, "command")) {
    return createCommandExecutionItem(value, index);
  }

  switch (type) {
    case "userMessage":
      return createUserMessageItem(value, index);
    case "agentMessage":
      return createAgentMessageItem(value, index);
    case "reasoning":
      return createReasoningItem(value, index);
    case "webSearch":
      return createWebSearchItem(value, index);
    case "contextCompaction":
      return {
        type: "contextCompaction",
        id: `lab-context-compaction-${index + 1}`,
      };
    default:
      return null;
  }
}

function createLabTurn(items: ThreadItem[]): Turn {
  return {
    id: "lab-turn",
    items,
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function createLabThreadPayload(turns: Turn[], cwd = "c:/git/web/workbench"): ThreadPayload<WorkbenchThreadId> {
  return {
    id: LabThreadIdSchema.parse("thread-render-lab"),
    harness: "codex",
    name: "Thread render lab",
    preview: "Pasted thread data",
    createdAt: 0,
    updatedAt: 0,
    status: turns.some((turn) => turn.status === "inProgress") ? "active" : "idle",
    cwd,
    source: "renderLab",
    path: null,
    agentNickname: null,
    agentRole: null,
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    agentPath: null,
    isDraft: false,
    tokenUsage: null,
    turnHistory: turns.map((turn) => ({
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      itemCount: turn.items.length,
      itemIds: turn.items.map((item) => item.id),
      loadState: "loaded",
      startedAt: turn.startedAt,
      status: turn.status,
      turnId: turn.id,
    })),
    turns,
  };
}

function readHarness(record: JsonObject, key: string): WorkbenchHarness {
  const value = readString(record, key);
  return ProviderKeySchema.parse(value ?? "codex");
}

function normalizeTurn(value: JsonValue, index = 0): Turn | null {
  if (!isJsonObject(value) || !Array.isArray(value.items)) {
    return null;
  }

  const items = value.items
    .map((item, itemIndex) => normalizeThreadItem(item, itemIndex))
    .filter((item): item is ThreadItem => Boolean(item));

  return {
    id: readString(value, "id") ?? `lab-turn-${index + 1}`,
    items,
    itemsView: "full",
    status: readString(value, "status") === "inProgress" ? "inProgress" : readString(value, "status") === "failed" ? "failed" : "completed",
    error: null,
    startedAt: readNumber(value, "startedAt"),
    completedAt: readNumber(value, "completedAt"),
    durationMs: readNumber(value, "durationMs"),
  };
}

function createThreadPayloadFromRecord(record: JsonObject): ThreadPayload | null {
  if (!Array.isArray(record.turns)) {
    return null;
  }

  const turns = record.turns
    .map((turn, index) => normalizeTurn(turn, index))
    .filter((turn): turn is Turn => Boolean(turn));
  const payload = createLabThreadPayload(turns, readString(record, "cwd") ?? "c:/git/web/workbench");

  return {
    ...payload,
    ...(record.isDraft === true
      ? { id: LabDraftIdSchema.parse(readString(record, "id") ?? payload.id), isDraft: true as const }
      : { id: LabThreadIdSchema.parse(readString(record, "id") ?? payload.id), isDraft: false as const }),
    harness: readHarness(record, "harness"),
    name: readString(record, "name"),
    preview: readString(record, "preview") ?? payload.preview,
    createdAt: readNumber(record, "createdAt") ?? payload.createdAt,
    updatedAt: readNumber(record, "updatedAt") ?? payload.updatedAt,
    status: readString(record, "status") ?? payload.status,
    source: readString(record, "source") ?? payload.source,
    path: readString(record, "path"),
    agentNickname: readString(record, "agentNickname"),
    agentRole: readString(record, "agentRole"),
    model: readString(record, "model"),
    reasoningEffort: readString(record, "reasoningEffort"),
    serviceTier: readString(record, "serviceTier"),
    agentPath: readString(record, "agentPath"),
    browseResultEntries: readBrowseResultEntries(record),
  };
}

function normalizeItemsArray(values: JsonValue[]): ThreadPayload | null {
  const items = values
    .map((item, index) => normalizeThreadItem(item, index))
    .filter((item): item is ThreadItem => Boolean(item));

  return items.length ? createLabThreadPayload([createLabTurn(items)]) : null;
}

function normalizeThreadPayload(value: JsonValue): ThreadPayload | null {
  if (!isJsonObject(value) || !Array.isArray(value.turns)) {
    return null;
  }

  if (readString(value, "harness")) {
    return createThreadPayloadFromRecord(value);
  }

  if (value.status !== undefined && isJsonObject(value.status)) {
    return toThreadPayload({ ...value as Thread, id: LabThreadIdSchema.parse(value.id) }, "codex");
  }

  const turns = value.turns
    .map((turn, index) => normalizeTurn(turn, index))
    .filter((turn): turn is Turn => Boolean(turn));
  return createLabThreadPayload(turns, readString(value, "cwd") ?? "c:/git/web/workbench");
}

export function parseThreadRenderInput(text: string): { error: string; thread: ThreadPayload | null } {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return {
      error: "",
      thread: null,
    };
  }

  try {
    const parsed = JSON.parse(trimmedText) as JsonValue;
    if (Array.isArray(parsed)) {
      const thread = normalizeItemsArray(parsed);
      return thread ? { error: "", thread } : { error: "Array did not contain renderable thread items.", thread: null };
    }

    if (isJsonObject(parsed) && parsed.thread) {
      const thread = normalizeThreadPayload(parsed.thread);
      return thread ? { error: "", thread } : { error: "The thread field was not a renderable thread payload.", thread: null };
    }

    const threadPayload = normalizeThreadPayload(parsed);
    if (threadPayload) {
      return {
        error: "",
        thread: threadPayload,
      };
    }

    const turn = normalizeTurn(parsed);
    if (turn) {
      return {
        error: "",
        thread: createLabThreadPayload([turn]),
      };
    }

    const item = normalizeThreadItem(parsed, 0);
    if (item) {
      return {
        error: "",
        thread: createLabThreadPayload([createLabTurn([item])]),
      };
    }

    return {
      error: "Paste a ThreadPayload, { thread }, Turn, ThreadItem[], command strings, or command objects.",
      thread: null,
    };
  } catch (parseError) {
    return {
      error: parseError instanceof Error ? parseError.message : "Invalid JSON.",
      thread: null,
    };
  }
}
