/*
 * CodexTranscriptSqliteImportInput: one hydrated Codex turn window plus its scoped Workbench facts. Keywords: codex, transcript, import, window.
 * createCodexTranscriptSqliteImport: convert one hydrated Codex turn window into stable Workbench observations. Keywords: codex, sqlite, transcript, import, window.
 */
import type { Thread } from "workbench-shared/codex/generated/app-server/v2/Thread";
import { toThreadPayload } from "workbench-shared/codex/thread-adapter";
import { applyQuestionnaireHistoryToThread } from "workbench-shared/workbench/thread/thread-questionnaire-history";
import { resolveQuestionnaireHistoryItemId } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import {
  applySteerHistoryToThread,
  resolveSteerHistoryItemId,
} from "workbench-shared/workbench/thread/thread-steer-history";
import { findWorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import type {
  WorkbenchBrowseResultEntry,
  WorkbenchQuestionnaireHistoryEntry,
  WorkbenchSteerHistoryEntry,
} from "workbench-shared/types";
import type {
  WorkbenchTranscriptAtomicObservation,
  WorkbenchTranscriptObservation,
} from "./database/transcript/workbench-transcript-types.ts";
import {
  createCodexTranscriptProviderItemObservation,
  type CodexTranscriptProviderContext,
} from "./codex-transcript-provider-observations.ts";
import { createFirstTurnItemOwners } from "./codex-transcript-item-ownership.ts";

export interface CodexTranscriptSqliteImportInput {
  browseAssets?: ReadonlyMap<string, Extract<WorkbenchTranscriptAtomicObservation, { kind: "browse" }>["asset"]>;
  browseResultEntries: WorkbenchBrowseResultEntry[];
  context: CodexTranscriptProviderContext;
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
  const questionnaireBySyntheticId = new Map(questionnaireEntries.map((entry) => [
    resolveQuestionnaireHistoryItemId(entry),
    entry,
  ]));
  const steerBySyntheticId = new Map(steerEntries.map((entry) => [resolveSteerHistoryItemId(entry), entry]));
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
  const itemOwners = createFirstTurnItemOwners(payload.turnHistory.map((history) => ({
    itemIds: history.itemIds ?? loadedTurnsById.get(history.turnId)?.items.map(({ id }) => id),
    turnId: history.turnId,
  })));
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
      const ownerTurnId = itemOwners.get(item.id);
      if (ownerTurnId && ownerTurnId !== turn.id) continue;
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
        ...createCodexTranscriptProviderItemObservation({
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
    contentVersion: 3,
    materializedTurnIds: payload.turns.map(({ id }) => id),
    threadId: thread.id,
    observations,
  };
}
