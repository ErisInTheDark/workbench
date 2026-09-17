/*
 * createSteerHistoryEntryFromRequest: admit a steer from a Codex request.
 * readSteerHistoryRequest: parse steer correlation without allocating identity.
 * getJsonRpcErrorMessage: read a bounded steer failure.
 * hasNativeSteerReconciliationEvidence: identify turns that can settle steers.
 * reconcileNativeSteerEntriesForTurns: reconcile delivery and interruption evidence.
 * sortSteerEntries: order native and legacy steer history.
 * updateMatchingPendingSteerEntriesForUserMessage: settle legacy steers by input match.
 * updateNativeSteerEntriesForInterruptedTurn: settle native interrupted steers.
 * updateNativeSteerEntriesForUserMessage: settle native delivered steers.
 * updatePendingSteerEntriesForInterruptedTurn: settle legacy interrupted steers.
 * updateSteerEntryStatus: apply terminal or delivered state.
 */
import { randomUUID } from "node:crypto";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "workbench-shared/codex/generated/app-server/v2/Turn";
import type { UserInput } from "workbench-shared/codex/generated/app-server/v2/UserInput";
import { areUserInputsEquivalentForUserMessageDedupe } from "workbench-shared/workbench/thread/thread-item-normalization";
import type { WorkbenchSteerHistoryEntry } from "workbench-shared/types";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types.ts";
import { asRecord, asString } from "./codex-transcript-normalizers.ts";

function readTextElements(value: unknown): Extract<UserInput, { type: "text" }>["text_elements"] | null {
  if (!Array.isArray(value)) return null;
  const elements: Extract<UserInput, { type: "text" }>["text_elements"] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const byteRange = asRecord(record?.byteRange);
    const start = typeof byteRange?.start === "number" ? byteRange.start : null;
    const end = typeof byteRange?.end === "number" ? byteRange.end : null;
    if (!record || start === null || end === null) return null;
    elements.push({
      byteRange: { end, start },
      placeholder: asString(record.placeholder) ?? "",
    });
  }
  return elements;
}

function readUserInput(value: unknown): UserInput | null {
  const record = asRecord(value);
  const type = asString(record?.type);
  if (!record || !type) return null;
  switch (type) {
    case "text": {
      const text = asString(record.text);
      const textElements = readTextElements(record.text_elements);
      return text !== null && textElements ? { text, text_elements: textElements, type } : null;
    }
    case "image": {
      const url = asString(record.url);
      return url !== null ? { type, url } : null;
    }
    case "localImage": {
      const path = asString(record.path);
      return path !== null ? { path, type } : null;
    }
    case "skill":
    case "mention": {
      const name = asString(record.name);
      const path = asString(record.path);
      return name !== null && path !== null ? { name, path, type } : null;
    }
    default:
      return null;
  }
}

function readUserInputArray(value: unknown): UserInput[] | null {
  if (!Array.isArray(value)) return null;
  const inputs: UserInput[] = [];
  for (const entry of value) {
    const input = readUserInput(entry);
    if (!input) return null;
    inputs.push(input);
  }
  return inputs;
}

function cloneUserInput(input: UserInput): UserInput {
  switch (input.type) {
    case "text":
      return {
        text: input.text,
        text_elements: input.text_elements.map((element) => ({
          byteRange: { ...element.byteRange },
          placeholder: element.placeholder,
        })),
        type: input.type,
      };
    case "image":
      return { type: input.type, url: input.url };
    case "localImage":
      return { path: input.path, type: input.type };
    case "skill":
    case "mention":
      return { name: input.name, path: input.path, type: input.type };
  }
}

export function sortSteerEntries(entries: WorkbenchSteerHistoryEntry[]) {
  return [...entries].sort((left, right) => {
    if (
      left.dispatchSequence !== null
      && left.dispatchSequence !== undefined
      && right.dispatchSequence !== null
      && right.dispatchSequence !== undefined
      && left.dispatchSequence !== right.dispatchSequence
    ) {
      return left.dispatchSequence - right.dispatchSequence;
    }
    if (left.attemptedAt !== right.attemptedAt) return left.attemptedAt - right.attemptedAt;
    return left.entryKey.localeCompare(right.entryKey);
  });
}

export function readSteerHistoryRequest(request: JsonRpcRequest) {
  if (request.method !== "turn/steer") return null;
  const params = asRecord(request.params);
  const threadId = asString(params?.threadId)?.trim() ?? "";
  const turnId = asString(params?.expectedTurnId)?.trim() || asString(params?.turnId)?.trim() || "";
  const input = readUserInputArray(params?.input);
  if (!threadId || !turnId || !input?.length) return null;

  const requestId = typeof request.id === "number" || typeof request.id === "string"
    ? String(request.id)
    : null;
  const clientUserMessageId = asString(params?.clientUserMessageId)?.trim() || null;
  return {
    clientUserMessageId,
    entryKey: clientUserMessageId
      ? `turn-steer-client:${clientUserMessageId}`
      : requestId
        ? `turn-steer:${requestId}`
        : null,
    input: input.map(cloneUserInput),
    requestId,
    threadId,
    turnId,
  };
}

export function createSteerHistoryEntryFromRequest(request: JsonRpcRequest): WorkbenchSteerHistoryEntry | null {
  const parsed = readSteerHistoryRequest(request);
  if (!parsed) return null;
  const itemId = randomUUID();
  return {
    ...parsed,
    itemId,
    entryKey: parsed.entryKey ?? `turn-steer:${itemId}`,
    attemptedAt: Date.now(),
    canonicalItemId: null,
    dispatchSequence: null,
    error: null,
    resolvedAt: null,
    status: "pending",
  };
}

export function getJsonRpcErrorMessage(response: JsonRpcResponse) {
  const error = asRecord(response.error);
  return asString(error?.message) ?? (error ? "turn/steer failed." : null);
}

export function updateSteerEntryStatus(
  entry: WorkbenchSteerHistoryEntry,
  status: WorkbenchSteerHistoryEntry["status"],
  resolvedAt: number,
  options: { canonicalItemId?: string | null; error?: string | null } = {},
): WorkbenchSteerHistoryEntry {
  if (entry.status === "sent" && status !== "sent") return entry;
  const hasCanonicalItemId = Object.prototype.hasOwnProperty.call(options, "canonicalItemId");
  const hasError = Object.prototype.hasOwnProperty.call(options, "error");
  return {
    ...entry,
    canonicalItemId: hasCanonicalItemId ? options.canonicalItemId ?? null : entry.canonicalItemId,
    error: hasError ? options.error ?? null : entry.error,
    resolvedAt,
    status,
  };
}

export function updateNativeSteerEntriesForUserMessage(
  entries: WorkbenchSteerHistoryEntry[],
  turnId: string,
  item: ThreadItem,
  resolvedAt: number,
) {
  if (item.type !== "userMessage" || !item.clientId) return entries;
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (entry.clientUserMessageId !== item.clientId) return entry;
    if (
      entry.status === "sent"
      && entry.turnId === turnId
      && entry.canonicalItemId === item.id
      && entry.error === null
    ) {
      return entry;
    }
    changed = true;
    return {
      ...updateSteerEntryStatus(entry, "sent", resolvedAt, { canonicalItemId: item.id, error: null }),
      turnId,
    };
  });
  return changed ? sortSteerEntries(nextEntries) : entries;
}

export function updateNativeSteerEntriesForInterruptedTurn(
  entries: WorkbenchSteerHistoryEntry[],
  turn: Turn,
  resolvedAt: number,
) {
  if (turn.status !== "interrupted") return entries;
  let nextEntries = entries;
  for (const item of turn.items) {
    nextEntries = updateNativeSteerEntriesForUserMessage(nextEntries, turn.id, item, resolvedAt);
  }
  let changed = nextEntries !== entries;
  const interruptedEntries = nextEntries.map((entry) => {
    if (entry.status !== "pending" || entry.turnId !== turn.id) return entry;
    changed = true;
    return updateSteerEntryStatus(entry, "interrupted", resolvedAt, {
      error: "The turn stopped before this steer was delivered.",
    });
  });
  return changed ? sortSteerEntries(interruptedEntries) : entries;
}

export function hasNativeSteerReconciliationEvidence(turn: Turn) {
  return turn.status === "interrupted"
    || turn.items.some((item) => item.type === "userMessage" && Boolean(item.clientId?.trim()));
}

export function reconcileNativeSteerEntriesForTurns(
  entries: WorkbenchSteerHistoryEntry[],
  turns: Turn[],
  resolvedAt: number,
) {
  let nextEntries = entries;
  for (const turn of turns) {
    for (const item of turn.items) {
      nextEntries = updateNativeSteerEntriesForUserMessage(nextEntries, turn.id, item, resolvedAt);
    }
    nextEntries = updateNativeSteerEntriesForInterruptedTurn(nextEntries, turn, resolvedAt);
  }
  return nextEntries;
}

export function updateMatchingPendingSteerEntriesForUserMessage(
  entries: WorkbenchSteerHistoryEntry[],
  item: ThreadItem,
  resolvedAt: number,
) {
  if (item.type !== "userMessage") return entries;
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (
      entry.status !== "pending"
      || Boolean(entry.clientUserMessageId?.trim())
      || !areUserInputsEquivalentForUserMessageDedupe(entry.input, item.content)
    ) {
      return entry;
    }
    changed = true;
    return updateSteerEntryStatus(entry, "sent", resolvedAt, { canonicalItemId: item.id, error: null });
  });
  return changed ? sortSteerEntries(nextEntries) : entries;
}

export function updatePendingSteerEntriesForInterruptedTurn(
  entries: WorkbenchSteerHistoryEntry[],
  turn: Turn,
  resolvedAt: number,
) {
  if (turn.status !== "interrupted") return entries;
  const canonicalUserMessages = turn.items.filter((
    item,
  ): item is Extract<ThreadItem, { type: "userMessage" }> => item.type === "userMessage");
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (entry.status !== "pending" || Boolean(entry.clientUserMessageId?.trim())) return entry;
    const canonicalMatch = canonicalUserMessages.find((item) => (
      areUserInputsEquivalentForUserMessageDedupe(entry.input, item.content)
    ));
    if (canonicalMatch) {
      changed = true;
      return updateSteerEntryStatus(entry, "sent", resolvedAt, { canonicalItemId: canonicalMatch.id, error: null });
    }
    changed = true;
    return updateSteerEntryStatus(entry, "interrupted", resolvedAt, {
      error: "The turn stopped before this steer was delivered.",
    });
  });
  return changed ? sortSteerEntries(nextEntries) : entries;
}
