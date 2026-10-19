/*
 * Exports:
 * - threadPayloadToProjection: project a pasted thread payload fixture into the canonical transcript projection the thread renderer draws.
 */
import type { ThreadPayload } from "workbench-shared/types";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import type {
  WorkbenchProjectedTranscriptItem,
  WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";

/** Fixtures carry turns in display order; the renderer only ever draws canonical projections. */
export function threadPayloadToProjection(thread: ThreadPayload, projectId = ""): WorkbenchTranscriptProjection {
  const timelines = new Map(thread.turnHistory.map(entry => [entry.turnId, entry.itemTimeline ?? []]));
  const turns = thread.turns.map((turn, turnIndex) => ({
    ...turn,
    itemTimeline: timelines.get(turn.id) ?? [],
    items: turn.items as WorkbenchProjectedTranscriptItem[],
    turnIndex,
  }));
  let itemIndex = 0;
  const display = planCanonicalTranscriptDisplay<WorkbenchProjectedTranscriptItem>({
    items: turns.flatMap(turn => turn.items.map(item => ({ itemId: item.id, itemIndex: itemIndex++, payload: item, turnId: turn.id }))),
    turns: turns.map(turn => ({ turnId: turn.id, turnIndex: turn.turnIndex })),
  });
  return {
    approvalEntries: [],
    browseResultEntries: thread.browseResultEntries ?? [],
    display,
    hasPreviousTurns: false,
    questionnaireEntries: [],
    steerEntries: [],
    thread: {
      activityAt: thread.updatedAt,
      createdAt: thread.createdAt,
      cwd: thread.cwd,
      id: thread.id,
      projectId,
      projectRoot: thread.cwd,
      title: thread.name ?? thread.preview,
      updatedAt: thread.updatedAt,
    },
    turnHistory: thread.turnHistory,
    turns,
  };
}
