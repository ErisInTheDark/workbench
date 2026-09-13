/*
 * Exports:
 * - default WorkbenchTranscriptLiveController: retain active text and patch previews independently of viewers and publish commit-scoped presentation.
 */
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import {
  projectWorkbenchTranscript,
  type WorkbenchProjectedTranscriptItem,
  type WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  applyTranscriptStructure,
  createTranscriptLayout,
  createTranscriptLayoutPatch,
  readTranscriptText,
  writeTranscriptText,
  type TranscriptLayout,
  type TranscriptLiveUpdate,
  type TranscriptPatchUpdate,
  type TranscriptStreamUpdate,
  type TranscriptTextField,
  type TranscriptTextUpdate,
} from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type { WorkbenchTranscriptSettlement } from "./workbench-transcript-types";

type Root = WorkbenchTranscriptSnapshot["rows"]["threadItems"][number];
type Turn = WorkbenchTranscriptSnapshot["turns"][number];
interface View {
  projection: WorkbenchTranscriptProjection;
  items: Map<string, WorkbenchProjectedTranscriptItem>;
  layout: TranscriptLayout;
  roots: Map<string, Root>;
  turns: Map<string, Turn>;
  publish: (update: TranscriptStreamUpdate) => void;
}

function fieldKey(update: Pick<TranscriptTextUpdate, "turnId" | "itemId" | "field" | "index">) {
  return `${update.turnId}\0${update.itemId}\0${update.field}\0${update.index ?? ""}`;
}

function liveFields(snapshot: WorkbenchTranscriptSnapshot): Map<number, TranscriptTextField[]> {
  const fields = new Map<number, TranscriptTextField[]>();
  for (const row of snapshot.rows.threadItemAssistantMessages) {
    if (row.state === "streaming") fields.set(row.item_id, ["agentMessageText"]);
  }
  for (const row of snapshot.rows.threadItemReasoning) {
    if (row.state === "streaming") fields.set(row.item_id, ["reasoningSummary", "reasoningContent"]);
  }
  for (const row of snapshot.rows.threadOperationProcessSources) {
    if (row.state === "inProgress") fields.set(row.item_id, ["commandExecutionOutput"]);
  }
  return fields;
}

export default class WorkbenchTranscriptLiveController {
  readonly #views = new Map<string, View>();
  readonly #fields = new Map<string, Map<string, TranscriptTextUpdate>>();
  readonly #patches = new Map<string, TranscriptPatchUpdate>();
  readonly #reportFailure: (error: unknown) => void;

  constructor(reportFailure: (error: unknown) => void = error => {
    console.warn(`[workbench-transcript] live publication failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
  }) {
    this.#reportFailure = reportFailure;
  }

  open(id: string, snapshot: WorkbenchTranscriptSnapshot | null, publish: View["publish"]) {
    this.close(id);
    if (!snapshot) {
      publish({ kind: "absent" });
      return;
    }
    this.#settleFields(snapshot, [], []);
    const projected = projectWorkbenchTranscript(snapshot);
    if (!projected.success) throw new Error("Transcript baseline could not be projected.");
    const layout = createTranscriptLayout(projected.data);
    const view: View = {
      layout,
      projection: projected.data,
      items: new Map(projected.data.turns.flatMap(turn => turn.items.map(item => [item.id, item] as const))),
      publish,
      roots: new Map(snapshot.rows.threadItems.map(root => [root.public_id ?? root.source_id, root])),
      turns: new Map(snapshot.turns.map(turn => [turn.id, turn])),
    };
    this.#views.set(id, view);
    publish({
      kind: "structure", reset: true, snapshot, removedItemIds: [],
      layout: createTranscriptLayoutPatch(null, layout), hasPreviousTurns: snapshot.hasPreviousTurns,
    });
    for (const update of this.#fields.get(snapshot.thread.id)?.values() ?? []) this.#publishText(view, update);
    const patch = this.#patches.get(snapshot.thread.id);
    if (patch) this.#publishPatch(view, patch);
  }

  close(id: string) {
    this.#views.delete(id);
  }

  hasView(id: string) {
    return this.#views.has(id);
  }

  dispose() {
    this.#views.clear();
    this.#fields.clear();
    this.#patches.clear();
  }

  acceptLiveUpdate(update: TranscriptLiveUpdate) {
    if (update.kind === "text") {
      this.acceptText(update);
      return;
    }
    const previous = this.#patches.get(update.threadId);
    if (!update.changes.length) {
      if (previous?.itemId === update.itemId && previous.turnId === update.turnId) this.acceptActivity(update.threadId);
      return;
    }
    if (previous && (previous.itemId !== update.itemId || previous.turnId !== update.turnId)) this.acceptActivity(update.threadId);
    this.#patches.set(update.threadId, update);
    for (const view of this.#views.values()) {
      if (view.projection.thread.id === update.threadId) this.#publishPatch(view, update);
    }
  }

  acceptActivity(threadId: string) {
    const patch = this.#patches.get(threadId);
    if (!patch) return;
    this.#patches.delete(threadId);
    for (const view of this.#views.values()) {
      if (view.projection.thread.id !== threadId) continue;
      try {
        this.#publishPatch(view, { ...patch, changes: [] });
      } catch (error) {
        this.#reportFailure(error);
      }
    }
  }

  acceptText(update: TranscriptTextUpdate) {
    this.acceptActivity(update.threadId);
    const fields = this.#fields.get(update.threadId) ?? new Map<string, TranscriptTextUpdate>();
    const key = fieldKey(update);
    const previous = fields.get(key);
    fields.set(key, {
      ...update, append: update.append && (previous?.append ?? true),
      text: update.append ? (previous?.text ?? "") + update.text : update.text,
    });
    this.#fields.set(update.threadId, fields);
    for (const view of this.#views.values()) {
      if (view.projection.thread.id === update.threadId) this.#publishText(view, update);
    }
  }

  settle(changes: NonNullable<WorkbenchTranscriptSettlement["changes"]>, { replaceLiveText = false } = {}) {
    for (const change of changes) {
      const completed = this.#settleFields(change.snapshot, change.removedItemIds, change.completedItemIds, replaceLiveText);
      for (const view of this.#views.values()) {
        if (view.projection.thread.id !== change.snapshot.thread.id) continue;
        try {
          this.#settleView(view, change);
          for (const update of completed) this.#publishText(view, update);
        } catch (error) {
          this.#reportFailure(error);
        }
      }
    }
  }

  #settleFields(snapshot: WorkbenchTranscriptSnapshot, removed: readonly string[], completedIds: readonly string[], replaceLiveText = false) {
    const fields = this.#fields.get(snapshot.thread.id) ?? new Map<string, TranscriptTextUpdate>();
    const active = liveFields(snapshot);
    const touched = new Map(snapshot.rows.threadItems.map(root => [root.public_id ?? root.source_id, root]));
    const projected = projectWorkbenchTranscript(snapshot);
    if (!projected.success) throw new Error("Committed transcript fields could not be projected.");
    const items = new Map(projected.data.turns.flatMap(turn => turn.items.map(item => [item.id, item] as const)));
    const completed: TranscriptTextUpdate[] = [];
    const terminalTurns = new Set(snapshot.turns
      .filter(turn => turn.state !== "inProgress" && turn.state !== "admitted")
      .map(turn => turn.id));
    const patch = this.#patches.get(snapshot.thread.id);
    if (patch && (removed.includes(patch.itemId) || completedIds.includes(patch.itemId) || terminalTurns.has(patch.turnId))) {
      this.acceptActivity(snapshot.thread.id);
    }
    for (const [key, field] of fields) {
      const root = touched.get(field.itemId);
      if (removed.includes(field.itemId) || completedIds.includes(field.itemId) || terminalTurns.has(field.turnId) || (root && !active.has(root.id))) {
        const item = items.get(field.itemId);
        if (!removed.includes(field.itemId)) completed.push({
          ...field, append: false, text: item ? readTranscriptText(item, field.field, field.index) : field.text,
        });
        fields.delete(key);
      }
    }
    for (const [id, root] of touched) {
      const item = items.get(id);
      if (!item || completedIds.includes(id) || terminalTurns.has(root.turn_id)) continue;
      for (const field of active.get(root.id) ?? []) {
        const indexes = item.type === "reasoning"
          ? (field === "reasoningSummary" ? item.summary : item.content).map((_, index) => index)
          : [null];
        for (const index of indexes) {
          const update: TranscriptTextUpdate = {
            kind: "text", threadId: snapshot.thread.id, turnId: root.turn_id,
            itemId: id, field, index, append: false, text: readTranscriptText(item, field, index),
          };
          const previous = fields.get(fieldKey(update));
          // Active text appends. A provider read may predate deltas already admitted here.
          if (previous?.append) {
            fields.set(fieldKey(update), { ...update, text: update.text + previous.text });
          } else if (!previous || (replaceLiveText && !previous.text.startsWith(update.text))) {
            fields.set(fieldKey(update), update);
          }
        }
      }
    }
    if (fields.size) this.#fields.set(snapshot.thread.id, fields);
    else this.#fields.delete(snapshot.thread.id);
    return completed;
  }

  #settleView(view: View, change: NonNullable<WorkbenchTranscriptSettlement["changes"]>[number]) {
    const { snapshot, removedItemIds } = change;
    const incoming = projectWorkbenchTranscript(snapshot);
    if (!incoming.success) throw new Error("Committed transcript structure could not be projected.");
    if (!snapshot.rows.threadItems.length && !removedItemIds.length && !snapshot.turns.length
      && areDeeplyEqual(incoming.data.thread, view.projection.thread)) return;
    const loaded = new Set(view.layout.turns);
    const lastIndex = Math.max(-1, ...view.projection.turns.map(turn => turn.turnIndex));
    for (const turn of snapshot.turns) {
      view.turns.set(turn.id, turn);
      if (turn.turn_index >= lastIndex && snapshot.loadedTurnIds.includes(turn.id)) loaded.add(turn.id);
    }
    for (const id of removedItemIds) view.roots.delete(id);
    for (const root of snapshot.rows.threadItems) {
      if (loaded.has(root.turn_id)) view.roots.set(root.public_id ?? root.source_id, root);
    }
    const payloads = new Map(view.projection.turns.flatMap(turn => turn.items.map(item => [item.id, item] as const)));
    for (const turn of incoming.data.turns) for (const item of turn.items) payloads.set(item.id, item);
    const turns = [...view.turns.values()].sort((left, right) => left.turn_index - right.turn_index);
    const roots = [...view.roots.entries()].sort(([, left], [, right]) =>
      (view.turns.get(left.turn_id)!.turn_index - view.turns.get(right.turn_id)!.turn_index)
      || left.item_position - right.item_position);
    const display = planCanonicalTranscriptDisplay({
      turns: turns.filter(turn => loaded.has(turn.id)).map(turn => ({ turnId: turn.id, turnIndex: turn.turn_index })),
      items: roots.map(([id, root], itemIndex) => ({
        itemId: id, turnId: root.turn_id, itemIndex, payload: payloads.get(id)!,
      })),
    });
    let offset = 0;
    const layout: TranscriptLayout = {
      turns: turns.filter(turn => loaded.has(turn.id)).map(turn => turn.id),
      history: turns.map(turn => turn.id),
      items: display.orderedItems.map(({ itemId, itemIndex, turnId }) => ({ itemId, itemIndex, turnId })),
      segments: display.segments.map(({ items, ...segment }) => {
        const result = { ...segment, offset, count: items.length };
        offset += items.length;
        return result;
      }),
    };
    const update = {
      kind: "structure" as const, reset: false, snapshot, removedItemIds,
      layout: createTranscriptLayoutPatch(view.layout, layout),
      hasPreviousTurns: view.projection.hasPreviousTurns,
    };
    view.projection = applyTranscriptStructure(view.projection, update, layout);
    view.items = new Map(view.projection.turns.flatMap(turn => turn.items.map(item => [item.id, item] as const)));
    view.layout = layout;
    view.publish(update);
    for (const field of this.#fields.get(snapshot.thread.id)?.values() ?? []) this.#publishText(view, field);
    const patch = this.#patches.get(snapshot.thread.id);
    if (patch) this.#publishPatch(view, patch);
  }

  #publishPatch(view: View, update: TranscriptPatchUpdate) {
    const turn = view.projection.turns.find(turn => turn.id === update.turnId);
    if (!update.changes.length) {
      if (turn) view.publish(update);
      return;
    }
    if (turn?.status !== "inProgress") return;
    const item = view.items.get(update.itemId);
    if (item) {
      if (item.type !== "fileChange" || item.status !== "inProgress"
        || view.roots.get(update.itemId)?.turn_id !== update.turnId) return;
      item.changes = update.changes;
    }
    // Patch generation precedes item/started. Its preview needs the turn, not a durable item body.
    view.publish(update);
  }

  #publishText(view: View, update: TranscriptTextUpdate) {
    const item = view.items.get(update.itemId);
    if (!item) return;
    const text = writeTranscriptText(item, update);
    const fields = this.#fields.get(update.threadId);
    const pending = fields?.get(fieldKey(update));
    if (pending?.append) fields!.set(fieldKey(update), { ...pending, append: false, text });
    view.publish(update);
  }
}
