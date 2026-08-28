/*
 * createSteerHistoryEntryFromRequest: admit one typed Workbench steer from a Codex request. Keywords: codex, transcript, steer, admission.
 * getJsonRpcErrorMessage: read one bounded JSON-RPC steer failure. Keywords: codex, transcript, steer, error.
 * getNextSteerDispatchSequence: derive the next durable native-steer order. Keywords: codex, transcript, steer, order.
 * hasNativeSteerReconciliationEvidence: identify provider turns that can settle native steers. Keywords: codex, transcript, steer, provider.
 * reconcileNativeSteerEntriesForTurns: apply provider user-message and interruption evidence to native steers. Keywords: codex, transcript, steer, reconcile.
 * sortSteerEntries: order native and legacy steer history deterministically. Keywords: codex, transcript, steer, order.
 * updateMatchingPendingSteerEntriesForUserMessage: settle legacy steers by semantic user-input match. Keywords: codex, transcript, steer, legacy.
 * updateNativeSteerEntriesForInterruptedTurn: settle native steers from one interrupted provider turn. Keywords: codex, transcript, steer, interrupted.
 * updateNativeSteerEntriesForUserMessage: settle native steers from one provider user item. Keywords: codex, transcript, steer, delivery.
 * updatePendingSteerEntriesForInterruptedTurn: settle legacy steers from one interrupted provider turn. Keywords: codex, transcript, steer, interrupted.
 * updateSteerEntryStatus: apply one terminal or delivered steer state. Keywords: codex, transcript, steer, state.
 */
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem.ts";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn.ts";
import type { UserInput } from "../lib/codex/generated/app-server/v2/UserInput.ts";
import { areUserInputsEquivalentForUserMessageDedupe } from "../lib/codex/thread-item-normalization.ts";
import type { WorkbenchSteerHistoryEntry } from "../lib/types.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types.ts";
import { asRecord, asString } from "./codex-transcript-normalizers.ts";
import type { CodexTranscriptThreadFile } from "./codex-transcript-types.ts";

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

export function createSteerHistoryEntryFromRequest(request: JsonRpcRequest): WorkbenchSteerHistoryEntry | null {
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
  const attemptedAt = Date.now();
  return {
    attemptedAt,
    canonicalItemId: null,
    clientUserMessageId,
    dispatchSequence: null,
    entryKey: clientUserMessageId
      ? `turn-steer-client:${clientUserMessageId}`
      : requestId
        ? `turn-steer:${requestId}`
        : `turn-steer:${attemptedAt}:${Math.random().toString(36).slice(2)}`,
    error: null,
    input: input.map(cloneUserInput),
    requestId,
    resolvedAt: null,
    status: "pending",
    threadId,
    turnId,
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

export function getNextSteerDispatchSequence(file: CodexTranscriptThreadFile) {
  if (file.nextSteerDispatchSequence !== undefined) return file.nextSteerDispatchSequence;
  return (file.steerEntries ?? []).reduce(
    (next, entry) => Math.max(next, (entry.dispatchSequence ?? -1) + 1),
    0,
  );
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
