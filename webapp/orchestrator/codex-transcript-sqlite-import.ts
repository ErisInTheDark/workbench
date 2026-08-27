/*
 * CodexTranscriptSqliteImportInput: one hydrated Codex turn window plus its scoped Workbench facts. Keywords: codex, transcript, import, window.
 * CodexTranscriptSqliteItemInput: one native Codex item lifecycle update ready for atomic shadow settlement. Keywords: codex, transcript, item, streaming.
 * createCodexTranscriptSqliteItemObservation: convert one native Codex item without rereading its turn. Keywords: codex, sqlite, transcript, item.
 * createCodexTranscriptSqliteImport: convert one hydrated Codex turn window into stable Workbench observations. Keywords: codex, sqlite, transcript, import, window.
 */
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread.ts";
import type { ThreadItem } from "../lib/codex/generated/app-server/v2/ThreadItem.ts";
import { toThreadPayload } from "../lib/codex/thread-adapter.ts";
import {
  SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX,
  applyQuestionnaireHistoryToThread,
} from "../lib/workbench/thread/thread-questionnaire-history.ts";
import {
  applySteerHistoryToThread,
  createSyntheticSteerHistoryItemId,
} from "../lib/workbench/thread/thread-steer-history.ts";
import { findWorkbenchThreadItemTimelineEntry } from "../lib/workbench/thread/thread-item-timeline.ts";
import type {
  WorkbenchBrowseResultEntry,
  WorkbenchQuestionnaireHistoryEntry,
  WorkbenchSteerHistoryEntry,
} from "../lib/types.ts";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptItemLifecycle,
  WorkbenchTranscriptObservation,
} from "./database/transcript/workbench-transcript-types.ts";

interface CodexTranscriptImportContext {
  activityAt: number;
  createdAt: number;
  nativeLocation: string;
  projectId: string;
  projectRoot: string;
  title: string;
  updatedAt: number;
}

export interface CodexTranscriptSqliteImportInput {
  browseAssets?: ReadonlyMap<string, Extract<WorkbenchTranscriptAtomicObservation, { kind: "browse" }>["asset"]>;
  browseResultEntries: WorkbenchBrowseResultEntry[];
  context: CodexTranscriptImportContext;
  questionnaireEntries: WorkbenchQuestionnaireHistoryEntry[];
  steerEntries: WorkbenchSteerHistoryEntry[];
  thread: Thread;
}

export interface CodexTranscriptSqliteItemInput {
  item: ThreadItem;
  lifecycle: WorkbenchTranscriptItemLifecycle;
  observedAt: number;
  threadId: string;
  turnId: string;
}

function itemTimeline(
  itemId: string,
  timeline: ReturnType<typeof findWorkbenchThreadItemTimelineEntry>,
) {
  if (!timeline) return undefined;
  const aliases = Array.from(new Set([
    ...(timeline.aliases ?? []),
    ...(timeline.itemId === itemId ? [] : [timeline.itemId]),
  ])).filter((alias) => alias !== itemId);
  return {
    ...(aliases.length ? { aliases } : {}),
    completedAt: timeline.completedAt,
    firstSeenAt: timeline.firstSeenAt,
    itemId,
    lastSeenAt: timeline.lastSeenAt,
    startedAt: timeline.startedAt,
  };
}

export function createCodexTranscriptSqliteItemObservation({
  item,
  lifecycle,
  observedAt,
  threadId,
  turnId,
}: CodexTranscriptSqliteItemInput): WorkbenchTranscriptAtomicObservation {
  return {
    item,
    kind: "item",
    lifecycle,
    observedAt,
    threadId,
    turnId,
  };
}

export function createCodexTranscriptSqliteImport({
  browseAssets = new Map(),
  browseResultEntries,
  context,
  questionnaireEntries,
  steerEntries,
  thread,
}: CodexTranscriptSqliteImportInput): WorkbenchTranscriptObservation {
  const payload = applySteerHistoryToThread(
    applyQuestionnaireHistoryToThread(toThreadPayload(thread), questionnaireEntries),
    steerEntries,
  );
  const questionnaireBySyntheticId = new Map(questionnaireEntries.map((entry) => [
    `${SYNTHETIC_QUESTIONNAIRE_HISTORY_ITEM_ID_PREFIX}${entry.threadId}:${entry.requestKey}`,
    entry,
  ]));
  const steerBySyntheticId = new Map(steerEntries.map((entry) => [createSyntheticSteerHistoryItemId(entry), entry]));
  const observations: WorkbenchTranscriptAtomicObservation[] = [{
    kind: "thread",
    threadId: thread.id,
    projectId: context.projectId,
    projectRoot: context.projectRoot,
    title: context.title,
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
    activityAt: context.activityAt,
  }];
  const loadedTurnsById = new Map(payload.turns.map((turn) => [turn.id, turn]));
  for (const [turnIndex, history] of payload.turnHistory.entries()) {
    const turn = loadedTurnsById.get(history.turnId);
    observations.push({
      kind: "turn",
      threadId: thread.id,
      turnId: history.turnId,
      turnIndex,
      harnessId: "codex",
      nativeLocation: context.nativeLocation,
      nativeThreadId: thread.id,
      nativeTurnId: history.turnId,
      state: turn?.status ?? history.status ?? "completed",
      createdAt: Math.round((turn?.startedAt ?? history.startedAt ?? thread.createdAt) * 1_000),
      startedAt: (turn?.startedAt ?? history.startedAt) === null
        ? null
        : Math.round((turn?.startedAt ?? history.startedAt)! * 1_000),
      endedAt: (turn?.completedAt ?? history.completedAt) === null
        ? null
        : Math.round((turn?.completedAt ?? history.completedAt)! * 1_000),
      durationMs: turn?.durationMs ?? history.durationMs,
    });
    if (!turn) continue;
    for (const item of turn.items) {
      const questionnaire = questionnaireBySyntheticId.get(item.id);
      if (questionnaire) {
        observations.push({ kind: "questionnaire", entry: questionnaire, observedAt: questionnaire.resolvedAt });
        continue;
      }
      const steer = steerBySyntheticId.get(item.id);
      if (steer) {
        observations.push({ kind: "steer", entry: steer, observedAt: steer.attemptedAt });
        continue;
      }
      const timeline = itemTimeline(
        item.id,
        findWorkbenchThreadItemTimelineEntry(item.id, history.itemTimeline),
      );
      observations.push({
        ...createCodexTranscriptSqliteItemObservation({
          item,
          lifecycle: turn.status === "inProgress" ? "streaming" : "completed",
          observedAt: timeline?.lastSeenAt
            ?? Math.round((turn.completedAt ?? turn.startedAt ?? thread.updatedAt) * 1_000),
          threadId: thread.id,
          turnId: turn.id,
        }),
        ...(timeline ? { timeline } : {}),
      });
    }
  }
  for (const entry of browseResultEntries) {
    const asset = browseAssets.get(entry.entryKey);
    observations.push({ kind: "browse", entry, ...(asset ? { asset } : {}) });
  }
  return {
    kind: "canonicalWindow",
    contentVersion: 2,
    materializedTurnIds: payload.turns.map(({ id }) => id),
    threadId: thread.id,
    observations,
  };
}
