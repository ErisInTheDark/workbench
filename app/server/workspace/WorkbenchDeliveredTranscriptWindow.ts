/*
 * Exports:
 * - default WorkbenchDeliveredTranscriptWindow: own one browser subscription's delivered transcript items, turns, layout and
 *   history boundary; rebase reservoir pages and daemon live changes into incremental browser structure updates, and keep
 *   settled tool output bodies app-side until the browser opens them.
 */
import {
  emptyTranscriptSnapshotRows,
  type WorkbenchTranscriptItemCursor,
  type WorkbenchTranscriptItemEnvelope,
  type WorkbenchTranscriptPrefetchResult,
  type WorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import {
  compareWorkbenchTranscriptItemCursors,
  composeWorkbenchTranscriptWindow,
  splitWorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/transcript/workbench-transcript-envelope";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { deferWorkbenchTranscriptEnvelopeBody } from "workbench-shared/workbench/transcript/workbench-transcript-deferred-bodies";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import {
  projectWorkbenchTranscript,
  type WorkbenchProjectedTranscriptItem,
  type WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import {
  applyTranscriptStructure,
  createTranscriptLayoutPatch,
  type TranscriptLayout,
  type TranscriptStructureUpdate,
} from "workbench-shared/workbench/transcript/thread-transcript-stream";

type Turn = WorkbenchTranscriptSnapshot["turns"][number];

function signature({ snapshot }: WorkbenchTranscriptItemEnvelope) {
  return JSON.stringify([snapshot.rows, snapshot.approvalOutcomes ?? [], snapshot.expiredItemPayloads ?? []]);
}
interface DeliveredRoot {
  cursor: WorkbenchTranscriptItemCursor;
  turnId: string;
}

export default class WorkbenchDeliveredTranscriptWindow {
  #thread: WorkbenchTranscriptSnapshot["thread"] | null = null;
  #projection: WorkbenchTranscriptProjection | null = null;
  #layout: TranscriptLayout | null = null;
  readonly #roots = new Map<string, DeliveredRoot>();
  /** Last delivered rows per item, so daemon baselines that replay unchanged items publish nothing. */
  readonly #signatures = new Map<string, string>();
  /** Complete envelopes of delivered items whose output rows were left out, served when the browser opens them. */
  readonly #bodies = new Map<string, WorkbenchTranscriptItemEnvelope>();
  readonly #turns = new Map<string, Turn>();
  readonly #loadedTurns = new Set<string>();
  #firstCursor: WorkbenchTranscriptItemCursor | null = null;
  #hasPreviousItems = true;
  /** No history existed when delivery began, so the daemon's first live baseline is the whole window. */
  #awaitingLiveBaseline = false;

  get published() {
    return this.#projection !== null;
  }

  get loadedTurnIds(): readonly string[] {
    return this.#layout?.turns ?? [];
  }

  delivers(itemId: string) {
    return this.#roots.has(itemId);
  }

  loadsTurn(turnId: string) {
    return this.#loadedTurns.has(turnId);
  }

  clear() {
    this.#thread = null;
    this.#projection = null;
    this.#layout = null;
    this.#roots.clear();
    this.#signatures.clear();
    this.#bodies.clear();
    this.#turns.clear();
    this.#loadedTurns.clear();
    this.#firstCursor = null;
    this.#hasPreviousItems = true;
    this.#awaitingLiveBaseline = false;
  }

  /** The thread has no transcript yet; its first live baseline becomes the browser baseline. */
  awaitLiveBaseline() {
    this.clear();
    this.#hasPreviousItems = false;
    this.#awaitingLiveBaseline = true;
  }

  /** Reservoir items older than the delivered boundary. The first delivery becomes the browser baseline. */
  deliver(result: WorkbenchTranscriptPrefetchResult): TranscriptStructureUpdate | null {
    const hadPrevious = this.#hasPreviousItems;
    if (!result.catalog) {
      if (!this.#projection) {
        this.awaitLiveBaseline();
        return null;
      }
      if (result.envelopes.length) throw new Error("Transcript item delivery is missing its catalogue.");
      this.#hasPreviousItems = false;
      return hadPrevious ? this.#apply(this.#emptyChange(), [], false) : null;
    }
    this.#awaitingLiveBaseline = false;
    this.#hasPreviousItems = result.hasMore;
    const fresh = result.envelopes.filter(envelope => !this.#roots.has(envelope.itemId));
    if (!this.#projection || !this.#thread) {
      this.#thread = result.catalog.thread;
      this.#signatures.clear();
      this.#bodies.clear();
      this.#remember(fresh);
      // The live turn's recent tools feed the live terminal, so only settled turns start deferred.
      const liveTurns = new Set(result.catalog.turns
        .filter(turn => turn.state === "inProgress" || turn.state === "admitted").map(turn => turn.id));
      const envelopes = fresh.map(envelope => liveTurns.has(envelope.snapshot.rows.threadItems[0]?.turn_id ?? "")
        ? envelope : this.#defer(envelope));
      return this.#apply(composeWorkbenchTranscriptWindow(result.catalog, envelopes, {
        hasPreviousItems: result.hasMore,
      }), [], true);
    }
    this.#remember(fresh);
    const envelopes = fresh.map(envelope => this.#defer(envelope));
    if (!envelopes.length && hadPrevious === result.hasMore) return null;
    // Reservoir catalogues can predate live state: live turns, thread and held steers stay authoritative.
    // The browser already holds every known turn, so a page carries only its own and newly seen ones.
    const pageTurnIds = new Set(envelopes.flatMap(envelope => envelope.snapshot.loadedTurnIds));
    const catalog: WorkbenchTranscriptSnapshot = {
      ...result.catalog,
      rows: emptyTranscriptSnapshotRows(),
      thread: this.#thread,
      turns: result.catalog.turns
        .filter(turn => pageTurnIds.has(turn.id) || !this.#turns.has(turn.id))
        .map(turn => this.#turns.get(turn.id) ?? turn),
    };
    return this.#apply(composeWorkbenchTranscriptWindow(catalog, envelopes, {
      hasPreviousItems: result.hasMore,
    }), [], false);
  }

  /** Daemon live structure. Baselines merge too: provider omission is not deletion. */
  receive(snapshot: WorkbenchTranscriptSnapshot, removedItemIds: readonly string[]): TranscriptStructureUpdate | null {
    if (!this.#projection) {
      if (!this.#awaitingLiveBaseline) return null;
      this.#awaitingLiveBaseline = false;
      this.#thread = snapshot.thread;
      this.#signatures.clear();
      this.#remember(splitWorkbenchTranscriptSnapshot(snapshot).envelopes);
      return this.#apply(snapshot, [], true);
    }
    const bounded = this.#bound(snapshot);
    const removed = removedItemIds.filter(id => this.#roots.has(id));
    const unchangedItems = snapshot.rows.threadItems.length > 0 && bounded.rows.threadItems.length === 0
      && areDeeplyEqual(snapshot.thread, this.#thread)
      && snapshot.turns.every(turn => areDeeplyEqual(turn, this.#turns.get(turn.id) ?? turn));
    if (!removed.length && (unchangedItems || this.#unchanged(bounded))) return null;
    this.#thread = snapshot.thread;
    return this.#apply(bounded, removed, false);
  }

  #remember(envelopes: readonly WorkbenchTranscriptItemEnvelope[]) {
    for (const envelope of envelopes) this.#signatures.set(envelope.itemId, signature(envelope));
  }

  #defer(envelope: WorkbenchTranscriptItemEnvelope) {
    const deferred = deferWorkbenchTranscriptEnvelopeBody(envelope);
    if (!deferred) return envelope;
    this.#bodies.set(envelope.itemId, envelope);
    return deferred;
  }

  /** Complete rows for delivered items whose bodies were deferred; unknown ids fail rather than return partial data. */
  bodies(itemIds: readonly string[]): WorkbenchTranscriptSnapshot {
    if (!this.#thread) throw new Error("Transcript delivery has not started.");
    const envelopes = itemIds.map(itemId => {
      const envelope = this.#bodies.get(itemId);
      if (!envelope) throw new Error(`Transcript item ${itemId.slice(0, 80)} has no deferred body.`);
      return envelope;
    });
    const turnIds = new Set(envelopes.flatMap(envelope => envelope.snapshot.loadedTurnIds));
    return composeWorkbenchTranscriptWindow({
      hasPreviousTurns: false,
      loadedTurnIds: [],
      rows: emptyTranscriptSnapshotRows(),
      thread: this.#thread,
      turns: [...turnIds].flatMap(id => {
        const turn = this.#turns.get(id);
        return turn ? [turn] : [];
      }),
    }, envelopes, { hasPreviousItems: false });
  }

  /** Same rule as the daemon live view: item-free changes matter when they carry turn, approval or thread facts. */
  #unchanged(snapshot: WorkbenchTranscriptSnapshot) {
    return snapshot.rows.threadItems.length === 0
      && snapshot.turns.length === 0
      && !snapshot.approvalOutcomes?.length
      && areDeeplyEqual(snapshot.thread, this.#thread);
  }

  /** Keeps changed items at or after the delivered boundary; baselines replaying delivered rows publish nothing. */
  #bound(snapshot: WorkbenchTranscriptSnapshot) {
    if (!snapshot.rows.threadItems.length) return snapshot;
    const firstCursor = this.#firstCursor;
    const partition = splitWorkbenchTranscriptSnapshot(snapshot);
    const changed = partition.envelopes.filter(envelope => {
      if (!this.#roots.has(envelope.itemId)
        && firstCursor && compareWorkbenchTranscriptItemCursors(envelope.cursor, firstCursor) < 0) return false;
      const next = signature(envelope);
      if (this.#signatures.get(envelope.itemId) === next) return false;
      this.#signatures.set(envelope.itemId, next);
      // Live changes travel complete, so the browser no longer needs a deferred body for this item.
      this.#bodies.delete(envelope.itemId);
      return true;
    });
    if (changed.length === partition.envelopes.length) return snapshot;
    return {
      ...composeWorkbenchTranscriptWindow(partition.catalog, changed, { hasPreviousItems: snapshot.hasPreviousTurns }),
      // Touched turns stay touched even when their changed items fall outside the window.
      loadedTurnIds: snapshot.loadedTurnIds,
    };
  }

  #emptyChange(): WorkbenchTranscriptSnapshot {
    return {
      hasPreviousTurns: this.#hasPreviousItems,
      loadedTurnIds: [],
      rows: emptyTranscriptSnapshotRows(),
      thread: this.#thread!,
      turns: [],
    };
  }

  #apply(snapshot: WorkbenchTranscriptSnapshot, removed: readonly string[], reset: boolean): TranscriptStructureUpdate {
    const incoming = projectWorkbenchTranscript(snapshot);
    if (!incoming.success) {
      const issue = incoming.issues[0];
      throw new Error(`Delivered transcript rows could not be projected: ${issue?.code ?? "unknown"} in ${issue?.table ?? "unknown"}.`);
    }
    if (reset) {
      this.#roots.clear();
      this.#loadedTurns.clear();
    }
    for (const turn of snapshot.turns) this.#turns.set(turn.id, turn);
    for (const id of removed) {
      this.#roots.delete(id);
      this.#signatures.delete(id);
      this.#bodies.delete(id);
    }
    const newestLoaded = Math.max(-1, ...[...this.#loadedTurns].map(id => this.#turns.get(id)?.turn_index ?? -1));
    for (const root of snapshot.rows.threadItems) {
      const turn = this.#turns.get(root.turn_id);
      if (!turn) throw new Error(`Delivered transcript item ${root.public_id} references missing turn ${root.turn_id}.`);
      this.#roots.set(root.public_id, {
        cursor: { itemId: root.public_id, itemPosition: root.item_position, turnIndex: turn.turn_index },
        turnId: root.turn_id,
      });
      this.#loadedTurns.add(root.turn_id);
    }
    // A new live turn may arrive before its first item.
    for (const turnId of snapshot.loadedTurnIds) {
      if ((this.#turns.get(turnId)?.turn_index ?? -1) > newestLoaded) this.#loadedTurns.add(turnId);
    }
    const roots = [...this.#roots.entries()]
      .sort(([, left], [, right]) => compareWorkbenchTranscriptItemCursors(left.cursor, right.cursor));
    this.#firstCursor = roots[0]?.[1].cursor ?? null;
    const payloads = new Map<string, WorkbenchProjectedTranscriptItem>();
    for (const turn of reset ? [] : this.#projection?.turns ?? []) for (const item of turn.items) payloads.set(item.id, item);
    for (const turn of incoming.data.turns) for (const item of turn.items) payloads.set(item.id, item);
    const turns = [...this.#turns.values()].sort((left, right) => left.turn_index - right.turn_index);
    const loadedTurns = turns.filter(turn => this.#loadedTurns.has(turn.id));
    const display = planCanonicalTranscriptDisplay({
      turns: loadedTurns.map(turn => ({ turnId: turn.id, turnIndex: turn.turn_index })),
      items: roots.map(([itemId, root], itemIndex) => {
        const payload = payloads.get(itemId);
        if (!payload) throw new Error(`Delivered transcript item ${itemId} has no projected payload.`);
        return { itemId, turnId: root.turnId, itemIndex, payload };
      }),
    });
    let offset = 0;
    const layout: TranscriptLayout = {
      turns: loadedTurns.map(turn => turn.id),
      history: turns.map(turn => turn.id),
      items: display.orderedItems.map(({ itemId, itemIndex, turnId }) => ({ itemId, itemIndex, turnId })),
      segments: display.segments.map(({ items, ...segment }) => {
        const result = { ...segment, offset, count: items.length };
        offset += items.length;
        return result;
      }),
    };
    const update: TranscriptStructureUpdate = {
      kind: "structure",
      reset,
      snapshot,
      removedItemIds: [...removed],
      layout: createTranscriptLayoutPatch(reset ? null : this.#layout, layout),
      hasPreviousTurns: this.#hasPreviousItems,
    };
    this.#projection = applyTranscriptStructure(reset ? null : this.#projection, update, layout);
    this.#layout = layout;
    return update;
  }
}
