/*
 * Exports:
 * - ThreadTranscriptProjectionSelection: selected window and locally owned input presentation.
 * - ThreadTranscriptProjectionState: SQLite source presentation lifecycle.
 * - default ThreadTranscriptProjectionController: own incremental publication, transient/local presentation, source-local failures and subscriptions.
 */
import type { ThreadPayload } from "workbench-shared/types";
import type WorkbenchTranscriptClient from "../database/transcript/WorkbenchTranscriptClient";
import type {
  WorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { getWorkbenchTurnAdmission, type WorkbenchAdmissionTurn } from "workbench-shared/workbench/thread/thread-admission";
import { isWorkbenchSyntheticSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-history";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import {
  projectWorkbenchTranscript,
  type WorkbenchProjectedTranscriptItem,
  type WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import {
  applyTranscriptLayoutPatch, applyTranscriptStructure, readTranscriptText, writeTranscriptText,
  type TranscriptLayout, type TranscriptStreamUpdate, type TranscriptTextUpdate,
} from "workbench-shared/workbench/transcript/thread-transcript-stream";
import {
  isUndeliveredInitialOptimisticInputItem,
  type OptimisticInitialInputProjection,
} from "../thread/ThreadOptimisticInputStore";

export interface ThreadTranscriptProjectionSelection {
  thread: ThreadPayload;
}

export type ThreadTranscriptProjectionState =
  | { status: "idle" }
  | { status: "unavailable"; threadId: string }
  | { status: "loading"; threadId: string; projection: WorkbenchTranscriptProjection | null }
  | { status: "ready"; threadId: string; projection: WorkbenchTranscriptProjection }
  | { status: "absent"; threadId: string }
  | { status: "failed"; threadId: string; message: string };

function isLocallyProjectedTurn(turn: Pick<WorkbenchAdmissionTurn, "id" | "workbenchAdmission">) {
  const admission = getWorkbenchTurnAdmission(turn);
  return admission === "connecting" || admission === "providerPending";
}

function durableTurnIds(
  turns: readonly Pick<WorkbenchAdmissionTurn, "id" | "workbenchAdmission">[] | null | undefined,
) {
  return (turns ?? [])
    .filter((turn) => !isLocallyProjectedTurn(turn))
    .map(({ id }) => id);
}

function sameDurableTurnIds(
  left: readonly Pick<WorkbenchAdmissionTurn, "id" | "workbenchAdmission">[] | null | undefined,
  right: readonly Pick<WorkbenchAdmissionTurn, "id" | "workbenchAdmission">[] | null | undefined,
) {
  const leftIds = durableTurnIds(left);
  const rightIds = durableTurnIds(right);
  return leftIds.length === rightIds.length
    && leftIds.every((turnId, index) => turnId === rightIds[index]);
}

function localSteers(thread: ThreadPayload | undefined) {
  return (thread?.turns ?? []).flatMap(turn => {
    const items = turn.items.flatMap(item => item.type === "userMessage" && isWorkbenchSyntheticSteerUserMessage(item) ? [item] : []);
    if (!items.length) return [];
    const ids = new Set(items.map(item => item.id));
    return [{
      turnId: turn.id, items,
      timeline: thread?.turnHistory.find(entry => entry.turnId === turn.id)?.itemTimeline?.filter(entry => ids.has(entry.itemId)) ?? [],
    }];
  });
}

function localInitials(
  thread: ThreadPayload | undefined,
  retained: readonly OptimisticInitialInputProjection[] = [],
) {
  const retainedById = new Map(retained.map(projection => [projection.item.id, projection]));
  return (thread?.turns ?? []).flatMap(turn => {
    const itemsById = new Map(turn.items
      .filter(item => item.type === "userMessage"
        && isUndeliveredInitialOptimisticInputItem(item)
        && (retainedById.get(item.id)?.turnId ?? turn.id) === turn.id)
      .map(item => [item.id, item]));
    for (const projection of retained) {
      if (projection.turnId === turn.id) itemsById.set(projection.item.id, projection.item);
    }
    const items = [...itemsById.values()];
    if (!items.length) return [];
    const ids = new Set(items.map(item => item.id));
    return [{
      turnId: turn.id, items,
      timeline: thread?.turnHistory.find(entry => entry.turnId === turn.id)?.itemTimeline?.filter(entry => ids.has(entry.itemId)) ?? [],
    }];
  });
}

interface ThreadTranscriptProjectionControllerOptions {
  available?: boolean;
  onError?: (error: Error) => void;
  onStateChange?: (state: ThreadTranscriptProjectionState) => void;
  onText?: (update: TranscriptTextUpdate, canonicalText: string) => void;
  readOptimisticInitials?: (thread: ThreadPayload) => readonly OptimisticInitialInputProjection[];
  transcripts: Pick<WorkbenchTranscriptClient, "subscribe" | "unsubscribe">;
  turnLimit: number;
}

export default class ThreadTranscriptProjectionController {
  readonly #subscriptionPrefix = `thread-transcript-projection:${crypto.randomUUID()}`;
  readonly #onError: NonNullable<ThreadTranscriptProjectionControllerOptions["onError"]>;
  readonly #onStateChange: NonNullable<ThreadTranscriptProjectionControllerOptions["onStateChange"]>;
  readonly #onText: NonNullable<ThreadTranscriptProjectionControllerOptions["onText"]>;
  readonly #readOptimisticInitials: NonNullable<ThreadTranscriptProjectionControllerOptions["readOptimisticInitials"]>;
  readonly #transcripts: ThreadTranscriptProjectionControllerOptions["transcripts"];
  readonly #turnLimit: number;
  #activeSubscriptionId: string | null = null;
  #available: boolean;
  #disposed = false;
  #generation = 0;
  #hasBeenAvailable = false;
  #lifecycle = Promise.resolve();
  #projection: { value: WorkbenchTranscriptProjection | null; generation: number } | null = null;
  #selection: ThreadTranscriptProjectionSelection | null = null;
  #streamLayout: TranscriptLayout | null = null;
  #streamItems = new Map<string, { turnId: string; item: WorkbenchProjectedTranscriptItem }>();
  #patchPreview: { turnId: string; item: Extract<WorkbenchProjectedTranscriptItem, { type: "fileChange" }> } | null = null;
  #incremental = false;
  #localInitials: ReturnType<typeof localInitials> = [];

  constructor({
    available = false,
    onError = (error) => console.error("Workbench transcript projection failed.", error),
    onStateChange = () => undefined,
    onText = () => undefined,
    readOptimisticInitials = () => [],
    transcripts,
    turnLimit,
  }: ThreadTranscriptProjectionControllerOptions) {
    this.#onError = onError;
    this.#onStateChange = onStateChange;
    this.#onText = onText;
    this.#readOptimisticInitials = readOptimisticInitials;
    this.#available = available;
    this.#transcripts = transcripts;
    this.#turnLimit = turnLimit;
  }

  dispose() {
    if (this.#disposed) return this.#lifecycle;
    this.#disposed = true;
    this.#selection = null;
    this.#localInitials = [];
    this.#projection = null;
    this.#streamItems.clear();
    this.#patchPreview = null;
    this.#streamLayout = null;
    this.#onStateChange({ status: "idle" });
    this.#generation += 1;
    this.#lifecycle = this.#lifecycle.then(async () => {
      const subscriptionId = this.#activeSubscriptionId;
      this.#activeSubscriptionId = null;
      if (subscriptionId && this.#available) await this.#transcripts.unsubscribe({ subscriptionId });
    }).catch(error => {
      if (this.#available) this.#onError(new Error("Unable to release the SQLite transcript subscription.", { cause: error }));
    });
    return this.#lifecycle;
  }

  setAvailable(available: boolean) {
    if (this.#disposed || this.#available === available) return;
    this.#available = available;
    if (available) this.#hasBeenAvailable = true;
    this.#projection = null;
    this.#streamItems.clear();
    this.#patchPreview = null;
    this.#streamLayout = null;
    this.#incremental = false;
    if (!available) {
      this.#generation += 1;
      this.#activeSubscriptionId = null;
      this.#publishUnavailableOrIdle();
      return;
    }
    this.#publishLoadingOrIdle();
    this.#replaceSubscription();
  }

  select(
    selection: ThreadTranscriptProjectionSelection | null,
    { publishState = true }: { publishState?: boolean } = {},
  ) {
    if (this.#disposed) return;
    const nextLocalInitials = selection
      ? localInitials(selection.thread, this.#readOptimisticInitials(selection.thread))
      : [];
    const previousThreadId = this.#selection?.thread.id ?? null;
    const nextThreadId = selection?.thread.id ?? null;
    const previousIds = durableTurnIds(this.#selection?.thread.turns);
    const nextIds = durableTurnIds(selection?.thread.turns);
    const appendedOnly = nextIds.length >= previousIds.length && previousIds.every((id, index) => nextIds[index] === id);
    const loadedTurnsChanged = !sameDurableTurnIds(this.#selection?.thread.turns, selection?.thread.turns)
      && !(this.#incremental && appendedOnly);
    const localPendingChanged = !areDeeplyEqual(
      this.#selection?.thread.turns.filter(isLocallyProjectedTurn) ?? [],
      selection?.thread.turns.filter(isLocallyProjectedTurn) ?? [],
    );
    const initialsChanged = !areDeeplyEqual(this.#localInitials, nextLocalInitials);
    const steersChanged = !areDeeplyEqual(localSteers(this.#selection?.thread), localSteers(selection?.thread));
    this.#selection = selection;
    this.#localInitials = nextLocalInitials;
    if (previousThreadId !== nextThreadId) {
      this.#projection = null;
      this.#streamItems.clear();
      this.#patchPreview = null;
      this.#streamLayout = null;
      if (!selection) {
        this.#onStateChange({ status: "idle" });
        this.#replaceSubscription();
        return;
      }
      if (!this.#available) {
        this.#generation += 1;
        this.#activeSubscriptionId = null;
        this.#publishDisconnectedOrLoading();
        return;
      }
      this.#publishLoadingOrIdle();
      this.#replaceSubscription();
      return;
    }
    if (loadedTurnsChanged) {
      if (!this.#available) {
        this.#generation += 1;
        this.#activeSubscriptionId = null;
        this.#publishDisconnectedOrLoading();
        return;
      }
      if (!this.#publishProjection("loading")) this.#publishLoadingOrIdle();
      this.#replaceSubscription();
      return;
    }
    if (publishState && (!this.#incremental || localPendingChanged || initialsChanged || steersChanged)) this.#publishProjection();
  }

  #reconcileCurrentProjection() {
    if (!this.#selection || !this.#projection?.value) return null;
    const projection = this.#projection.value;
    const canonicalItems = projection.turns.flatMap(turn => turn.items);
    const canonicalIds = new Set(canonicalItems.map(item => item.id));
    const previews = this.#patchPreview ? [this.#patchPreview] : [];
    const canonicalClients = new Set(canonicalItems.flatMap(item => item.type === "userMessage" && item.clientId ? [item.clientId] : []));
    const initials = this.#localInitials.map(entry => ({
      ...entry,
      items: entry.items.filter(item => !canonicalIds.has(item.id) && !(
        item.type === "userMessage" && item.clientId && canonicalClients.has(item.clientId)
      )),
    })).filter(entry => entry.items.length > 0);
    const steers = localSteers(this.#selection.thread).map(entry => ({
      ...entry,
      items: entry.items.filter(item => !canonicalIds.has(item.id) && !(item.clientId && canonicalClients.has(item.clientId))),
    })).filter(entry => entry.items.length > 0);
    // Local pre-admission input is not provider transcript truth. Keep it visible until admission.
    const pending = this.#selection.thread.turns.filter(turn =>
      isLocallyProjectedTurn(turn) && !projection.turns.some(existing => existing.id === turn.id));
    if (!pending.length && !initials.length && !steers.length && !previews.length) return projection;
    const pendingTurns = pending.map((turn, index) => ({
      ...turn, turnIndex: Math.max(-1, ...projection.turns.map(existing => existing.turnIndex)) + index + 1,
      itemTimeline: this.#selection!.thread.turnHistory.find(entry => entry.turnId === turn.id)?.itemTimeline ?? [],
    }));
    const turns = [...projection.turns, ...pendingTurns];
    for (const entry of initials) {
      const index = turns.findIndex(turn => turn.id === entry.turnId);
      if (index >= 0) {
        const turn = turns[index]!;
        const items = entry.items.filter(item => !turn.items.some(existing => existing.id === item.id));
        turns[index] = {
          ...turn, items: [...items, ...turn.items],
          itemTimeline: [
            ...entry.timeline.filter(event => items.some(item => item.id === event.itemId)),
            ...turn.itemTimeline,
          ],
        };
      } else {
        const source = this.#selection.thread.turns.find(turn => turn.id === entry.turnId)!;
        turns.push({
          ...source, items: entry.items, itemTimeline: entry.timeline,
          turnIndex: Math.max(-1, ...turns.map(turn => turn.turnIndex)) + 1,
        });
      }
    }
    for (const { turnId, item } of previews) {
      const index = turns.findIndex(turn => turn.id === turnId);
      if (index < 0 || turns[index]!.status !== "inProgress") continue;
      const turn = turns[index]!;
      turns[index] = { ...turn, items: [...turn.items, item] };
    }
    for (const entry of steers) {
      const index = turns.findIndex(turn => turn.id === entry.turnId);
      if (index >= 0) {
        const turn = turns[index]!;
        const items = entry.items.filter(item => !turn.items.some(existing => existing.id === item.id));
        turns[index] = {
          ...turn, items: [...turn.items, ...items],
          itemTimeline: [...turn.itemTimeline, ...entry.timeline.filter(event => items.some(item => item.id === event.itemId))],
        };
      } else {
        const source = this.#selection.thread.turns.find(turn => turn.id === entry.turnId)!;
        turns.push({
          ...source, items: entry.items, itemTimeline: entry.timeline,
          turnIndex: Math.max(-1, ...turns.map(turn => turn.turnIndex)) + 1,
        });
      }
    }
    const virtualHead = initials.flatMap(entry => entry.items.map(payload => ({ turnId: entry.turnId, payload })));
    const virtualTail = [
      ...previews.flatMap(({ turnId, item }) => turns.some(turn => (
        turn.id === turnId && turn.items.some(existing => existing.id === item.id)
      )) ? [{ turnId, payload: item }] : []),
      ...steers.flatMap(entry => entry.items.map(payload => ({ turnId: entry.turnId, payload }))),
    ];
    const histories = turns.map(turn => ({
      completedAt: turn.completedAt, durationMs: turn.durationMs,
      itemCount: turn.items.length, itemIds: turn.items.map(item => item.id),
      itemTimeline: turn.itemTimeline, loadState: "loaded" as const,
      startedAt: turn.startedAt, status: turn.status, turnId: turn.id,
    }));
    return {
      ...projection,
      turns,
      display: planCanonicalTranscriptDisplay({
        items: projection.display.orderedItems,
        turns: turns.map(turn => ({ turnId: turn.id, turnIndex: turn.turnIndex })),
        virtualHead,
        virtualTail,
      }),
      turnHistory: [
        ...projection.turnHistory.map(entry => histories.find(history => history.turnId === entry.turnId) ?? entry),
        ...histories.filter(history => !projection.turnHistory.some(entry => entry.turnId === history.turnId)),
      ],
    };
  }

  #publishProjection(status: "loading" | "ready" = "ready") {
    let projection: WorkbenchTranscriptProjection | null;
    try {
      projection = this.#reconcileCurrentProjection();
    } catch (error) {
      const threadId = this.#selection?.thread.id;
      if (!threadId) return false;
      const cause = error instanceof Error ? error : new Error(String(error));
      this.#onStateChange({
        message: "Unable to present the SQLite transcript.",
        status: "failed",
        threadId,
      });
      this.#onError(new Error(`SQLite transcript presentation failed: ${cause.message}`, { cause }));
      return true;
    }
    if (!projection) return false;
    this.#onStateChange({
      projection,
      status: this.#projection?.generation === this.#generation ? status : "loading",
      threadId: projection.thread.id,
    });
    return true;
  }

  #publishLoadingOrIdle() {
    const threadId = this.#selection?.thread.id;
    if (!threadId) {
      this.#onStateChange({ status: "idle" });
      return;
    }
    this.#onStateChange({ projection: null, status: "loading", threadId });
  }

  #publishUnavailableOrIdle() {
    const threadId = this.#selection?.thread.id;
    this.#onStateChange(threadId
      ? { status: "unavailable", threadId }
      : { status: "idle" });
  }

  #publishDisconnectedOrLoading() {
    if (this.#hasBeenAvailable) {
      this.#publishUnavailableOrIdle();
      return;
    }
    this.#publishLoadingOrIdle();
  }

  #receiveSnapshot(generation: number, snapshot: WorkbenchTranscriptSnapshot | null) {
    if (this.#disposed || !this.#available) return;
    // A superseded window can reveal the same thread while its replacement loads,
    // but cannot erase or overwrite content already accepted by this owner.
    if (generation !== this.#generation && (this.#projection || !snapshot)) return;
    if (snapshot === null) {
      this.#projection = { value: null, generation };
      this.#streamItems.clear();
      this.#patchPreview = null;
      this.#streamLayout = null;
      const threadId = this.#selection?.thread.id;
      this.#onStateChange(threadId
        ? { status: "absent", threadId }
        : { status: "idle" });
      return;
    }
    if (snapshot.thread.id !== this.#selection?.thread.id) return;
    const result = projectWorkbenchTranscript(snapshot);
    if ("issues" in result) {
      if (generation !== this.#generation) return;
      this.#projection = { value: null, generation };
      this.#onStateChange({
        message: "SQLite transcript data could not be projected.",
        status: "failed",
        threadId: snapshot.thread.id,
      });
      this.#onError(new Error("SQLite transcript data could not be projected."));
      return;
    }
    this.#projection = { value: result.data, generation };
    this.#publishProjection();
  }

  #receiveStream(generation: number, update: TranscriptStreamUpdate) {
    if (this.#disposed || !this.#available || generation !== this.#generation) return;
    this.#incremental = true;
    if (update.kind === "absent") {
      this.#receiveSnapshot(generation, null);
      return;
    }
    const threadId = update.kind === "structure" ? update.snapshot.thread.id : update.threadId;
    if (threadId !== this.#selection?.thread.id) return;
    if (update.kind === "patch") {
      if (!update.changes.length) {
        if (this.#patchPreview?.item.id === update.itemId && this.#patchPreview.turnId === update.turnId) {
          this.#patchPreview = null;
          this.#publishProjection();
        }
        return;
      }
      const projection = this.#projection?.value;
      const turn = projection?.turns.find(turn => turn.id === update.turnId);
      const canonical = this.#streamItems.get(update.itemId);
      const entry = canonical ?? (this.#patchPreview?.item.id === update.itemId ? this.#patchPreview : null);
      if (!projection || !turn || (entry && (entry.turnId !== update.turnId || entry.item.type !== "fileChange"))) {
        this.#onError(new Error("SQLite patch update arrived without its turn or with a conflicting item."));
        return;
      }
      if (turn.status !== "inProgress" || (entry?.item.type === "fileChange" && entry.item.status !== "inProgress")) return;
      if (entry?.item.type === "fileChange" && areDeeplyEqual(entry.item.changes, update.changes)) return;
      const item: Extract<WorkbenchProjectedTranscriptItem, { type: "fileChange" }> = {
        ...(entry?.item.type === "fileChange" ? entry.item : { type: "fileChange", id: update.itemId, status: "inProgress" }),
        changes: update.changes,
      };
      this.#patchPreview = canonical ? null : { turnId: update.turnId, item };
      if (canonical) {
        this.#streamItems.set(update.itemId, { turnId: update.turnId, item });
        // All published paths must point at the replacement, never mutate a subscriber's old snapshot.
        this.#projection = { generation, value: {
          ...projection,
          turns: projection.turns.map(existing => existing === turn
            ? { ...turn, items: turn.items.map(previous => previous.id === item.id ? item : previous) }
            : existing),
          display: {
            orderedItems: projection.display.orderedItems.map(previous => previous.itemId === item.id
              ? { ...previous, payload: item } : previous),
            segments: projection.display.segments.map(segment => segment.items.some(previous => previous.id === item.id)
              ? { ...segment, items: segment.items.map(previous => previous.id === item.id ? item : previous) }
              : segment),
          },
        } };
      }
      this.#publishProjection();
      return;
    }
    if (update.kind === "text") {
      const item = this.#streamItems.get(update.itemId)?.item;
      if (!item) {
        this.#onError(new Error("SQLite text update arrived without its item baseline."));
        return;
      }
      const previous = readTranscriptText(item, update.field, update.index);
      const text = writeTranscriptText(item, update);
      this.#onText(update, text);
      // The first nonempty field creates a rendering leaf; subsequent text only updates that leaf.
      if (!previous.trim() && text.trim()) this.#publishProjection();
      return;
    }
    try {
      const layout = applyTranscriptLayoutPatch(update.reset ? null : this.#streamLayout, update.layout);
      const projection = applyTranscriptStructure(this.#projection?.value ?? null, update, layout);
      const streamItems = new Map(projection.turns.flatMap(turn => turn.items.map(item => [item.id, { turnId: turn.id, item }] as const)));
      const preview = this.#patchPreview;
      if (preview && (update.reset || streamItems.has(preview.item.id) || update.removedItemIds.includes(preview.item.id)
        || !projection.turns.some(turn => turn.id === preview.turnId && turn.status === "inProgress"))) {
        this.#patchPreview = null;
      }
      this.#streamLayout = layout;
      this.#streamItems = streamItems;
      this.#projection = { value: projection, generation };
      this.#publishProjection();
    } catch (error) {
      this.#onError(new Error("SQLite structural update could not be applied.", { cause: error }));
      if (!this.#projection?.value) {
        this.#onStateChange({ status: "failed", threadId, message: "Unable to present the SQLite transcript baseline." });
      }
    }
  }

  #reportError(error: unknown, generation = this.#generation) {
    if (this.#disposed || !this.#available) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    const threadId = this.#selection?.thread.id ?? "none";
    const turnIds = this.#selection?.thread.turns.map(({ id }) => id).join(",") || "none";
    if (generation === this.#generation && this.#selection) {
      this.#projection = { value: null, generation };
      this.#onStateChange({
        message: `Unable to load the SQLite transcript: ${cause.message}`.slice(0, 500),
        status: "failed",
        threadId: this.#selection.thread.id,
      });
    }
    this.#onError(new Error(
      `Workbench transcript subscription failed. threadId=${threadId} turnIds=${turnIds}: ${cause.message}`,
      { cause },
    ));
  }

  #replaceSubscription() {
    const generation = ++this.#generation;
    const selection = this.#selection;
    this.#lifecycle = this.#lifecycle
      .then(async () => {
        if (this.#disposed) return;
        if (!this.#available) {
          this.#activeSubscriptionId = null;
          return;
        }
        if (this.#activeSubscriptionId) {
          const activeSubscriptionId = this.#activeSubscriptionId;
          this.#activeSubscriptionId = null;
          await this.#transcripts.unsubscribe({ subscriptionId: activeSubscriptionId });
        }
        if (this.#disposed || !this.#available || generation !== this.#generation || !selection) return;
        const subscriptionId = `${this.#subscriptionPrefix}:${generation}`;
        this.#activeSubscriptionId = subscriptionId;
        await this.#transcripts.subscribe({
          subscriptionId,
          threadId: selection.thread.id,
          turnIds: durableTurnIds(selection.thread.turns),
          turnLimit: this.#turnLimit,
        }, (snapshot) => this.#receiveSnapshot(generation, snapshot),
        update => this.#receiveStream(generation, update));
        if (!this.#disposed && generation !== this.#generation) {
          if (this.#activeSubscriptionId === subscriptionId) this.#activeSubscriptionId = null;
          await this.#transcripts.unsubscribe({ subscriptionId });
        }
      })
      .catch((error) => this.#reportError(error, generation));
  }
}
