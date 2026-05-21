/*
 * Exports:
 * - asRecord/asString/asNumber: small unknown-value readers used by transcript storage. Keywords: unknown, guards, json.
 * - toSerializableJson: normalize parsed JSON values into a strict JSON value. Keywords: serializable, raw payload.
 * - encodeTranscriptPathSegment: encode thread, turn, and request ids for filesystem paths. Keywords: base64url, path segment.
 * - extractThread/extractTurn/extractThreadId/extractTurnId/extractItem: pull thread-scoped entities from app-server traffic. Keywords: codex, transcript, normalization.
 */
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { SerializableJson } from "./codex-transcript-types";

export function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toSerializableJson(value: unknown): SerializableJson {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value as SerializableJson;
  }

  if (Array.isArray(value)) {
    return value.map(toSerializableJson);
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, toSerializableJson(entry)]));
}

export function encodeTranscriptPathSegment(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function extractThread(value: unknown): Thread | null {
  const record = asRecord(value);
  const result = asRecord(record?.result);
  const params = asRecord(record?.params);
  const resultThread = asRecord(result?.thread);
  const paramsThread = asRecord(params?.thread);
  return (resultThread ?? paramsThread) as Thread | null;
}

export function extractTurn(value: unknown): Turn | null {
  const record = asRecord(value);
  const params = asRecord(record?.params);
  const turn = asRecord(params?.turn);
  return turn as Turn | null;
}

export function extractItem(value: unknown): ThreadItem | null {
  const record = asRecord(value);
  const params = asRecord(record?.params);
  const item = asRecord(params?.item);
  return item as ThreadItem | null;
}

export function extractThreadId(value: unknown) {
  const record = asRecord(value);
  const result = asRecord(record?.result);
  const params = asRecord(record?.params);
  const thread = asRecord(result?.thread) ?? asRecord(params?.thread);
  return asString(params?.threadId)
    ?? asString(params?.conversationId)
    ?? asString(thread?.id);
}

export function extractTurnId(value: unknown) {
  const record = asRecord(value);
  const params = asRecord(record?.params);
  const turn = asRecord(params?.turn);
  return asString(params?.turnId) ?? asString(turn?.id);
}
