/*
 * Exports:
 * - SerializableJson: recursive JSON value type for raw transcript payloads. Keywords: json, raw events, transcript.
 * - CodexTranscriptRawEvent: raw bridge/app-server event persisted in thread transcript files. Keywords: codex, transcript, raw event.
 * - CodexTranscriptThreadFile/CodexTranscriptTurnFile/CodexTranscriptRequestFile: disk schema records for thread transcript storage. Keywords: disk schema, thread, turn, request.
 */
import type { CODEX_TRANSCRIPT_SCHEMA_VERSION } from "./codex-transcript-version";
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { WorkbenchQuestionnaireHistoryEntry } from "../lib/types";

export type SerializableJson =
  | null
  | boolean
  | number
  | string
  | SerializableJson[]
  | { [key: string]: SerializableJson };

export interface CodexTranscriptRawEvent {
  id: string;
  method: string | null;
  receivedAt: number;
  requestId: number | string | null;
  source: "client-request" | "upstream-response" | "upstream-notification" | "upstream-server-request" | "workbench";
  payload: SerializableJson;
}

export interface CodexTranscriptTurnIndexEntry {
  completedAt: number | null;
  itemCount: number;
  startedAt: number | null;
  status: Turn["status"] | null;
  turnId: string;
  updatedAt: number;
}

export interface CodexTranscriptThreadFile {
  cliVersion: string | null;
  createdAt: number;
  encodedThreadId: string;
  lastTouchedAt: number;
  schemaVersion: typeof CODEX_TRANSCRIPT_SCHEMA_VERSION;
  sourceThreadIds: string[];
  thread: Thread | null;
  threadId: string;
  turnIndex: CodexTranscriptTurnIndexEntry[];
}

export interface CodexTranscriptTurnTimelineEntry {
  anchorItemId: string | null;
  itemId: string;
  sequence: number;
}

export interface CodexTranscriptTurnFile {
  itemOrder: string[];
  itemTimeline: CodexTranscriptTurnTimelineEntry[];
  lastTouchedAt: number;
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  schemaVersion: typeof CODEX_TRANSCRIPT_SCHEMA_VERSION;
  threadId: string;
  turn: Turn | null;
  turnId: string;
}

export interface CodexTranscriptRequestFile {
  lastTouchedAt: number;
  requestKey: string;
  schemaVersion: typeof CODEX_TRANSCRIPT_SCHEMA_VERSION;
  threadId: string;
  turnId: string | null;
}

export interface CodexTranscriptOrphanEventsFile {
  lastTouchedAt: number;
  schemaVersion: typeof CODEX_TRANSCRIPT_SCHEMA_VERSION;
  threadId: string;
}
