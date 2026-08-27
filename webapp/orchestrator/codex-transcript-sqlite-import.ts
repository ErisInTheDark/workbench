/*
 * CodexTranscriptSqliteImportInput: complete legacy Codex transcript facts required for one canonical SQLite snapshot. Keywords: codex, transcript, import.
 * createCodexTranscriptSqliteImport: collapse one fully hydrated Codex transcript into stable Workbench observations. Keywords: codex, sqlite, transcript, import.
 */
import type { Thread } from "../lib/codex/generated/app-server/v2/Thread.ts";
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
  const turnHistoryById = new Map(payload.turnHistory.map((entry, index) => [entry.turnId, { entry, index }]));
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
  let itemIndex = 0;
  const orderedTurns = [...payload.turns].sort((left, right) => (
    (turnHistoryById.get(left.id)?.index ?? Number.MAX_SAFE_INTEGER)
    - (turnHistoryById.get(right.id)?.index ?? Number.MAX_SAFE_INTEGER)
  ));
  for (const turn of orderedTurns) {
    const history = turnHistoryById.get(turn.id);
    observations.push({
      kind: "turn",
      threadId: thread.id,
      turnId: turn.id,
      turnIndex: history?.index,
      harnessId: "codex",
      nativeLocation: context.nativeLocation,
      nativeThreadId: thread.id,
      nativeTurnId: turn.id,
      state: turn.status,
      createdAt: Math.round((turn.startedAt ?? thread.createdAt) * 1_000),
      startedAt: turn.startedAt === null ? null : Math.round(turn.startedAt * 1_000),
      endedAt: turn.completedAt === null ? null : Math.round(turn.completedAt * 1_000),
      durationMs: turn.durationMs,
    });
    for (const item of turn.items) {
      const questionnaire = questionnaireBySyntheticId.get(item.id);
      if (questionnaire) {
        observations.push({ kind: "questionnaire", entry: questionnaire, observedAt: questionnaire.resolvedAt, itemIndex });
        itemIndex += 1;
        continue;
      }
      const steer = steerBySyntheticId.get(item.id);
      if (steer) {
        observations.push({ kind: "steer", entry: steer, observedAt: steer.attemptedAt, itemIndex });
        itemIndex += 1;
        continue;
      }
      const timeline = itemTimeline(
        item.id,
        findWorkbenchThreadItemTimelineEntry(item.id, history?.entry.itemTimeline),
      );
      observations.push({
        kind: "item",
        threadId: thread.id,
        turnId: turn.id,
        item,
        lifecycle: turn.status === "inProgress" ? "streaming" : "completed",
        observedAt: timeline?.lastSeenAt
          ?? Math.round((turn.completedAt ?? turn.startedAt ?? thread.updatedAt) * 1_000),
        itemIndex,
        ...(timeline ? { timeline } : {}),
      });
      itemIndex += 1;
    }
  }
  for (const entry of browseResultEntries) {
    const asset = browseAssets.get(entry.entryKey);
    observations.push({ kind: "browse", entry, ...(asset ? { asset } : {}) });
  }
  return {
    kind: "canonicalSnapshot",
    contentVersion: 2,
    threadId: thread.id,
    observations,
  };
}
