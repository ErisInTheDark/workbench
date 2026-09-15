/*
 * Exports:
 * - TranscriptTextField/TranscriptTextUpdate: provider-independent live text fields.
 * - TranscriptPatchUpdate/TranscriptLiveUpdate: transient file patches and text without durable writes.
 * - TranscriptLayout/TranscriptLayoutPatch/TranscriptSequenceEdit: server-decided presentation positions.
 * - TranscriptStructureUpdate/TranscriptStreamUpdate: incremental transcript publication.
 * - createTranscriptLayout/createTranscriptLayoutPatch/applyTranscriptLayoutPatch: encode and apply ordered placement.
 * - applyTranscriptStructure: reconstruct changed content using server placement, without browser reconciliation.
 * - readTranscriptText/writeTranscriptText: access one live presentation field.
 */
import { areDeeplyEqual } from "../deep-equality.ts";
import type { FileUpdateChange } from "../thread/workbench-thread-items.ts";
import type { WorkbenchTranscriptSnapshot } from "../database/transcript/workbench-transcript-contract.ts";
import {
  projectWorkbenchTranscript,
  type WorkbenchProjectedTranscriptItem,
  type WorkbenchTranscriptProjection,
} from "./workbench-transcript-projection.ts";

export type TranscriptTextField =
  | "agentMessageText" | "commandExecutionOutput"
  | "reasoningContent" | "reasoningSummary";

export interface TranscriptTextUpdate {
  kind: "text";
  threadId: string;
  turnId: string;
  itemId: string;
  field: TranscriptTextField;
  index: number | null;
  text: string;
  append: boolean;
}

export interface TranscriptPatchUpdate {
  kind: "patch";
  threadId: string;
  turnId: string;
  itemId: string;
  // Empty changes withdraw this transient preview, never delete or complete its canonical item.
  changes: FileUpdateChange[];
}

export type TranscriptLiveUpdate = TranscriptTextUpdate | TranscriptPatchUpdate;
type Segment = WorkbenchTranscriptProjection["display"]["segments"][number];
export interface TranscriptLayout {
  turns: string[];
  history: string[];
  items: { itemId: string; turnId: string; itemIndex: number }[];
  segments: (Omit<Segment, "items"> & { offset: number; count: number })[];
}

export interface TranscriptSequenceEdit<Value> {
  offset: number;
  deleteCount: number;
  values: Value[];
}

export type TranscriptLayoutPatch = {
  [Key in keyof TranscriptLayout]?: TranscriptSequenceEdit<TranscriptLayout[Key][number]>;
};

export interface TranscriptStructureUpdate {
  kind: "structure";
  reset: boolean;
  snapshot: WorkbenchTranscriptSnapshot;
  removedItemIds: string[];
  layout: TranscriptLayoutPatch;
  hasPreviousTurns: boolean;
}

export type TranscriptStreamUpdate = TranscriptStructureUpdate | TranscriptLiveUpdate | { kind: "absent" };

export function createTranscriptLayout(projection: WorkbenchTranscriptProjection): TranscriptLayout {
  let offset = 0;
  return {
    turns: projection.turns.map(turn => turn.id),
    history: projection.turnHistory.map(turn => turn.turnId),
    items: projection.display.orderedItems.map(({ itemId, itemIndex, turnId }) => ({ itemId, itemIndex, turnId })),
    segments: projection.display.segments.map(({ items, ...segment }) => {
      const result = { ...segment, offset, count: items.length };
      offset += items.length;
      return result;
    }),
  };
}

function sequenceEdit<Value>(previous: readonly Value[], next: readonly Value[]): TranscriptSequenceEdit<Value> | undefined {
  let start = 0;
  while (start < previous.length && start < next.length && areDeeplyEqual(previous[start], next[start])) start++;
  if (start === previous.length && start === next.length) return undefined;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > start && nextEnd > start && areDeeplyEqual(previous[previousEnd - 1], next[nextEnd - 1])) {
    previousEnd--;
    nextEnd--;
  }
  return { offset: start, deleteCount: previousEnd - start, values: next.slice(start, nextEnd) };
}

export function createTranscriptLayoutPatch(previous: TranscriptLayout | null, next: TranscriptLayout): TranscriptLayoutPatch {
  return {
    turns: sequenceEdit(previous?.turns ?? [], next.turns),
    history: sequenceEdit(previous?.history ?? [], next.history),
    items: sequenceEdit(previous?.items ?? [], next.items),
    segments: sequenceEdit(previous?.segments ?? [], next.segments),
  };
}

function applySequence<Value>(previous: Value[], edit: TranscriptSequenceEdit<Value> | undefined): Value[] {
  if (!edit) return previous;
  const result = [...previous];
  result.splice(edit.offset, edit.deleteCount, ...edit.values);
  return result;
}

export function applyTranscriptLayoutPatch(previous: TranscriptLayout | null, patch: TranscriptLayoutPatch): TranscriptLayout {
  return {
    turns: applySequence(previous?.turns ?? [], patch.turns),
    history: applySequence(previous?.history ?? [], patch.history),
    items: applySequence(previous?.items ?? [], patch.items),
    segments: applySequence(previous?.segments ?? [], patch.segments),
  };
}

export function applyTranscriptStructure(
  previous: WorkbenchTranscriptProjection | null,
  update: TranscriptStructureUpdate,
  layout: TranscriptLayout,
): WorkbenchTranscriptProjection {
  const result = projectWorkbenchTranscript(update.snapshot);
  if (!result.success) throw new Error("Transcript structural rows could not be projected.");
  const incoming = result.data;
  const retained = update.reset ? null : previous;
  const removed = new Set(update.removedItemIds);
  const items = new Map<string, WorkbenchProjectedTranscriptItem>();
  const timelines = new Map<string, WorkbenchTranscriptProjection["turns"][number]["itemTimeline"][number]>();
  const turns = new Map((retained?.turns ?? []).map(turn => [turn.id, turn]));
  const history = new Map((retained?.turnHistory ?? []).map(turn => [turn.turnId, turn]));
  const browse = new Map((retained?.browseResultEntries ?? []).map(entry => [entry.entryKey, entry]));
  for (const projection of [retained, incoming]) {
    for (const turn of projection?.turns ?? []) {
      for (const item of turn.items) if (!removed.has(item.id)) items.set(item.id, item);
      for (const entry of turn.itemTimeline) if (!removed.has(entry.itemId)) timelines.set(entry.itemId, entry);
    }
  }
  for (const turn of incoming.turns) turns.set(turn.id, turn);
  for (const turn of incoming.turnHistory) history.set(turn.turnId, turn);
  const touched = new Set(update.snapshot.rows.threadItems.map(item => item.public_id ?? item.source_id));
  for (const [key, entry] of browse) {
    if (entry.commandItemId && (removed.has(entry.commandItemId) || touched.has(entry.commandItemId))) browse.delete(key);
  }
  for (const entry of incoming.browseResultEntries) browse.set(entry.entryKey, entry);
  // A replaced augmentation may remove its timeline entirely.
  for (const id of touched) {
    if (!incoming.turns.some(turn => turn.itemTimeline.some(entry => entry.itemId === id))) timelines.delete(id);
  }
  const orderedItems = layout.items.flatMap(entry => {
    const payload = items.get(entry.itemId);
    return payload ? [{ ...entry, payload }] : [];
  });
  const projectedTurns = layout.turns.flatMap(id => {
    const turn = turns.get(id);
    if (!turn) return [];
    const turnItems = orderedItems.filter(item => item.turnId === id).map(item => item.payload);
    return [{
      ...turn,
      items: turnItems,
      itemTimeline: turnItems.flatMap(item => {
        const entry = timelines.get(item.id);
        return entry ? [entry] : [];
      }),
    }];
  });
  const loaded = new Map(projectedTurns.map(turn => [turn.id, turn]));
  return {
    thread: incoming.thread,
    hasPreviousTurns: update.hasPreviousTurns,
    browseResultEntries: [...browse.values()],
    turns: projectedTurns,
    turnHistory: layout.history.flatMap(id => {
      const entry = history.get(id);
      if (!entry) return [];
      const turn = loaded.get(id);
      return [{
        ...entry,
        ...(turn ? { itemCount: turn.items.length, itemIds: turn.items.map(item => item.id), itemTimeline: turn.itemTimeline } : {}),
      }];
    }),
    display: {
      orderedItems,
      segments: layout.segments.map(({ offset, count, ...segment }) => ({
        ...segment, items: orderedItems.slice(offset, offset + count).map(item => item.payload),
      })),
    },
  };
}

export function readTranscriptText(item: WorkbenchProjectedTranscriptItem, field: TranscriptTextField, index: number | null): string {
  if (field === "agentMessageText" && item.type === "agentMessage") return item.text;
  if (field === "commandExecutionOutput" && item.type === "commandExecution") return item.aggregatedOutput ?? "";
  if (item.type === "reasoning" && index !== null) {
    if (field === "reasoningContent") return item.content[index] ?? "";
    if (field === "reasoningSummary") return item.summary[index] ?? "";
  }
  return "";
}

export function writeTranscriptText(item: WorkbenchProjectedTranscriptItem, update: TranscriptTextUpdate): string {
  const text = update.append ? readTranscriptText(item, update.field, update.index) + update.text : update.text;
  if (update.field === "agentMessageText" && item.type === "agentMessage") item.text = text;
  else if (update.field === "commandExecutionOutput" && item.type === "commandExecution") item.aggregatedOutput = text;
  else if (item.type === "reasoning" && update.index !== null) {
    if (update.field === "reasoningContent") item.content[update.index] = text;
    else if (update.field === "reasoningSummary") item.summary[update.index] = text;
  }
  return text;
}
