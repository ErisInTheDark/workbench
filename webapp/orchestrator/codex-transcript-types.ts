/*
 * Exports:
 * - SerializableJson: recursive JSON value type for raw transcript payloads. Keywords: json, raw events, transcript.
 * - CodexTranscriptRawEvent: raw bridge/app-server event persisted in thread transcript files. Keywords: codex, transcript, raw event.
 * - CodexTranscriptThreadFile/CodexTranscriptTurnFile: disk schema records for thread transcript storage. Keywords: disk schema, thread, turn.
 */
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread";
import type { Turn } from "../lib/codex/generated/app-server/v2/Turn";
import type { WorkbenchBrowseResultEntry, WorkbenchQuestionnaireHistoryEntry, WorkbenchSteerHistoryEntry } from "../lib/types";

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
  itemIds?: string[];
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
  schemaVersion: number;
  sourceThreadIds: string[];
  thread: Thread | null;
  threadId: string;
  turnIndex: CodexTranscriptTurnIndexEntry[];
}

export interface CodexTranscriptTurnTimelineEntry {
  aliases?: string[];
  anchorItemId: string | null;
  completedAt?: number | null;
  firstSeenAt?: number | null;
  itemId: string;
  lastSeenAt?: number | null;
  sequence: number;
  startedAt?: number | null;
}

export interface CodexTranscriptTurnFile {
  browseResultEntries: WorkbenchBrowseResultEntry[];
  itemOrder: string[];
  itemTimeline: CodexTranscriptTurnTimelineEntry[];
  lastTouchedAt: number;
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  schemaVersion: number;
  steerEntries: WorkbenchSteerHistoryEntry[];
  threadId: string;
  turn: Turn | null;
  turnId: string;
}

export interface CodexTranscriptOrphanEventsFile {
  lastTouchedAt: number;
  schemaVersion: number;
  threadId: string;
}
