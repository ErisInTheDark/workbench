/*
 * Exports:
 * - ThreadTranscriptProjectionSelection: selected window, local inputs and legacy comparison facts.
 * - ThreadTranscriptProjectionState: SQLite source presentation lifecycle.
 * - default ThreadTranscriptProjectionController: own incremental publication, local input presentation and subscriptions.
 */
import type { ThreadPayload, WorkbenchBrowseResultEntry } from "workbench-shared/types";
import type WorkbenchTranscriptClient from "../database/transcript/WorkbenchTranscriptClient";
import type {
  WorkbenchTranscriptParityDiagnostic,
  WorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { getWorkbenchTurnAdmission, type WorkbenchAdmissionTurn } from "workbench-shared/workbench/thread/thread-admission";
import { isWorkbenchSyntheticSteerUserMessage } from "workbench-shared/workbench/thread/thread-steer-history";
import { planCanonicalTranscriptDisplay } from "workbench-shared/workbench/transcript/thread-transcript-display-planner";
import {
  compareWorkbenchTranscriptParity,
  createWorkbenchTranscriptProjectionFailureDiagnostic,
} from "./thread-transcript-parity";
import {
  projectWorkbenchTranscript,
  type WorkbenchProjectedTranscriptItem,
  type WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";
import {
  applyTranscriptLayoutPatch, applyTranscriptStructure, readTranscriptText, writeTranscriptText,
  type TranscriptLayout, type TranscriptStreamUpdate, type TranscriptTextUpdate,
} from "workbench-shared/workbench/transcript/thread-transcript-stream";

export interface ThreadTranscriptProjectionSelection {
  browseResultEntries: readonly WorkbenchBrowseResultEntry[];
  thread: ThreadPayload;
}

export type ThreadTranscriptProjectionState =
  | { status: "idle" }
  | { status: "unavailable"; threadId: string }
  | { status: "loading"; threadId: string; projection: WorkbenchTranscriptProjection | null }
  | { status: "ready"; threadId: string; projection: WorkbenchTranscriptProjection }
  | { status: "absent"; threadId: string }
  | { status: "failed"; threadId: string; message: string };

function durableTurnIds(
  turns: readonly Pick<WorkbenchAdmissionTurn, "id" | "workbenchAdmission">[] | null | undefined,
) {
  return (turns ?? [])
    .filter((turn) => getWorkbenchTurnAdmission(turn) !== "connecting")
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

interface ThreadTranscriptProjectionControllerOptions {
  available?: boolean;
  cancelComparison?: (timer: ReturnType<typeof setTimeout>) => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: ThreadTranscriptProjectionState) => void;
  onText?: (update: TranscriptTextUpdate, canonicalText: string) => void;
  reconcileProjection?: (
    projection: WorkbenchTranscriptProjection,
    selection: ThreadTranscriptProjectionSelection,
  ) => WorkbenchTranscriptProjection;
  scheduleComparison?: (callback: () => void) => ReturnType<typeof setTimeout>;
  transcripts: Pick<WorkbenchTranscriptClient, "reportParity" | "subscribe" | "unsubscribe">;
  turnLimit: number;
}

export default class ThreadTranscriptProjectionController {
  readonly #subscriptionPrefix = `thread-transcript-projection:${crypto.randomUUID()}`;
  readonly #cancelComparison: NonNullable<ThreadTranscriptProjectionControllerOptions["cancelComparison"]>;
  readonly #onError: NonNullable<ThreadTranscriptProjectionControllerOptions["onError"]>;
  readonly #onStateChange: NonNullable<ThreadTranscriptProjectionControllerOptions["onStateChange"]>;
  readonly #onText: NonNullable<ThreadTranscriptProjectionControllerOptions["onText"]>;
  readonly #reconcileProjection: NonNullable<ThreadTranscriptProjectionControllerOptions["reconcileProjection"]>;
  readonly #scheduleComparison: NonNullable<ThreadTranscriptProjectionControllerOptions["scheduleComparison"]>;
  readonly #transcripts: ThreadTranscriptProjectionControllerOptions["transcripts"];
  readonly #turnLimit: number;
  #activeSubscriptionId: string | null = null;
  #available: boolean;
  #comparisonTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  #generation = 0;
  #hasBeenAvailable = false;
  #lastDiagnostic: WorkbenchTranscriptParityDiagnostic | null = null;
  #lifecycle = Promise.resolve();
  #projection: { value: WorkbenchTranscriptProjection | null; generation: number } | null = null;
  #reporting = Promise.resolve();
  #selection: ThreadTranscriptProjectionSelection | null = null;
  #streamLayout: TranscriptLayout | null = null;
  #streamItems = new Map<string, WorkbenchProjectedTranscriptItem>();
  #incremental = false;

  constructor({
    available = false,
    cancelComparison = (timer) => clearTimeout(timer),
    onError = (error) => console.error("Workbench transcript projection failed.", error),
    onStateChange = () => undefined,
    onText = () => undefined,
    reconcileProjection = (projection) => projection,
    scheduleComparison = (callback) => setTimeout(callback, 0),
    transcripts,
    turnLimit,
  }: ThreadTranscriptProjectionControllerOptions) {
    this.#cancelComparison = cancelComparison;
    this.#onError = onError;
    this.#onStateChange = onStateChange;
    this.#onText = onText;
    this.#available = available;
    this.#reconcileProjection = reconcileProjection;
    this.#scheduleComparison = scheduleComparison;
    this.#transcripts = transcripts;
    this.#turnLimit = turnLimit;
  }

  dispose() {
    if (this.#disposed) return this.#lifecycle;
    this.#disposed = true;
    this.#cancelScheduledComparison();
    this.#selection = null;
    this.#projection = null;
    this.#streamItems.clear();
    this.#streamLayout = null;
    this.#onStateChange({ status: "idle" });
    this.#lastDiagnostic = null;
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
    this.#cancelScheduledComparison();
    this.#projection = null;
    this.#streamItems.clear();
    this.#streamLayout = null;
    this.#incremental = false;
    this.#lastDiagnostic = null;
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
    const previousThreadId = this.#selection?.thread.id ?? null;
    const nextThreadId = selection?.thread.id ?? null;
    const previousIds = durableTurnIds(this.#selection?.thread.turns);
    const nextIds = durableTurnIds(selection?.thread.turns);
    const appendedOnly = nextIds.length >= previousIds.length && previousIds.every((id, index) => nextIds[index] === id);
    const loadedTurnsChanged = !sameDurableTurnIds(this.#selection?.thread.turns, selection?.thread.turns)
      && !(this.#incremental && appendedOnly);
    const connectingChanged = !areDeeplyEqual(
      this.#selection?.thread.turns.filter(turn => getWorkbenchTurnAdmission(turn) === "connecting") ?? [],
      selection?.thread.turns.filter(turn => getWorkbenchTurnAdmission(turn) === "connecting") ?? [],
    );
    const steersChanged = !areDeeplyEqual(localSteers(this.#selection?.thread), localSteers(selection?.thread));
    this.#selection = selection;
    if (previousThreadId !== nextThreadId) {
      this.#cancelScheduledComparison();
      this.#projection = null;
      this.#streamItems.clear();
      this.#streamLayout = null;
      this.#lastDiagnostic = null;
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
      this.#cancelScheduledComparison();
      this.#lastDiagnostic = null;
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
    if (publishState && (!this.#incremental || connectingChanged || steersChanged)) this.#publishProjection();
  }

  #cancelScheduledComparison() {
    if (this.#comparisonTimer === null) return;
    this.#cancelComparison(this.#comparisonTimer);
    this.#comparisonTimer = null;
  }

  #scheduleCompare() {
    if (this.#comparisonTimer !== null || !this.#selection || !this.#projection) return;
    const generation = this.#generation;
    this.#comparisonTimer = this.#scheduleComparison(() => {
      this.#comparisonTimer = null;
      if (this.#disposed || !this.#available || generation !== this.#generation) return;
      this.#compare();
    });
  }

  #compare() {
    const projection = this.#reconcileCurrentProjection();
    if (!projection || !this.#selection) return;
    const result = compareWorkbenchTranscriptParity({
      jsonBrowseResultEntries: this.#selection.browseResultEntries,
      jsonThread: this.#selection.thread,
      sqliteProjection: projection,
    });
    if (!("diagnostic" in result)) {
      this.#lastDiagnostic = null;
      return;
    }
    this.#report(result.diagnostic);
  }

  #reconcileCurrentProjection() {
    if (!this.#selection || !this.#projection?.value) return null;
    if (this.#incremental) {
      const projection = this.#projection.value;
      const canonicalItems = projection.turns.flatMap(turn => turn.items);
      const canonicalIds = new Set(canonicalItems.map(item => item.id));
      const canonicalClients = new Set(canonicalItems.flatMap(item => item.type === "userMessage" && item.clientId ? [item.clientId] : []));
      const steers = localSteers(this.#selection.thread).map(entry => ({
        ...entry,
        items: entry.items.filter(item => !canonicalIds.has(item.id) && !(item.clientId && canonicalClients.has(item.clientId))),
      })).filter(entry => entry.items.length > 0);
      // Local connecting input is not provider transcript truth. Keep it visible until admission.
      const pending = this.#selection.thread.turns.filter(turn =>
        getWorkbenchTurnAdmission(turn) === "connecting" && !projection.turns.some(existing => existing.id === turn.id));
      if (!pending.length && !steers.length) return projection;
      const pendingTurns = pending.map((turn, index) => ({
        ...turn, turnIndex: Math.max(-1, ...projection.turns.map(existing => existing.turnIndex)) + index + 1,
        itemTimeline: this.#selection!.thread.turnHistory.find(entry => entry.turnId === turn.id)?.itemTimeline ?? [],
      }));
      const turns = [...projection.turns, ...pendingTurns];
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
      const virtualTail = turns.flatMap(turn => turn.items
        .filter(item => !canonicalIds.has(item.id)).map(payload => ({ turnId: turn.id, payload })));
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
          items: projection.display.orderedItems, turns: turns.map(turn => ({ turnId: turn.id, turnIndex: turn.turnIndex })), virtualTail,
        }),
        turnHistory: [
          ...projection.turnHistory.map(entry => histories.find(history => history.turnId === entry.turnId) ?? entry),
          ...histories.filter(history => !projection.turnHistory.some(entry => entry.turnId === history.turnId)),
        ],
      };
    }
    let projection: WorkbenchTranscriptProjection;
    try {
      projection = this.#reconcileProjection(this.#projection.value, this.#selection);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      this.#projection = { value: null, generation: this.#projection.generation };
      this.#onStateChange({
        message: `SQLite transcript projection failed: ${cause.message}`.slice(0, 500),
        status: "failed",
        threadId: this.#selection.thread.id,
      });
      this.#onError(cause);
      return null;
    }
    return projection;
  }

  #publishProjection(status: "loading" | "ready" = "ready") {
    const projection = this.#reconcileCurrentProjection();
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
      this.#cancelScheduledComparison();
      this.#projection = { value: null, generation };
      const threadId = this.#selection?.thread.id;
      this.#onStateChange(threadId
        ? { status: "absent", threadId }
        : { status: "idle" });
      this.#lastDiagnostic = null;
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
      this.#report(createWorkbenchTranscriptProjectionFailureDiagnostic(snapshot.thread.id, result.issues));
      return;
    }
    this.#projection = { value: result.data, generation };
    if (this.#publishProjection() && generation === this.#generation) this.#scheduleCompare();
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
      const item = this.#streamItems.get(update.itemId);
      if (item?.type === "fileChange") {
        item.changes = update.changes;
        this.#publishProjection();
      } else {
        this.#onError(new Error("SQLite patch update arrived without its file-change baseline."));
      }
      return;
    }
    if (update.kind === "text") {
      const item = this.#streamItems.get(update.itemId);
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
      this.#streamLayout = layout;
      this.#streamItems = new Map(projection.turns.flatMap(turn => turn.items.map(item => [item.id, item] as const)));
      this.#projection = { value: projection, generation };
      this.#publishProjection();
      this.#scheduleCompare();
    } catch (error) {
      this.#onError(new Error("SQLite structural update could not be applied.", { cause: error }));
      if (!this.#projection?.value) {
        this.#onStateChange({ status: "failed", threadId, message: "Unable to present the SQLite transcript baseline." });
      }
    }
  }

  #reportError(stage: "report" | "subscription", error: unknown, generation = this.#generation) {
    if (this.#disposed || !this.#available) return;
    const cause = error instanceof Error ? error : new Error(String(error));
    const threadId = this.#selection?.thread.id ?? "none";
    const turnIds = this.#selection?.thread.turns.map(({ id }) => id).join(",") || "none";
    if (stage === "subscription" && generation === this.#generation && this.#selection) {
      this.#projection = { value: null, generation };
      this.#onStateChange({
        message: `Unable to load the SQLite transcript: ${cause.message}`.slice(0, 500),
        status: "failed",
        threadId: this.#selection.thread.id,
      });
    }
    this.#onError(new Error(
      `Workbench transcript projection lifecycle failed. stage=${stage} threadId=${threadId} turnIds=${turnIds}: ${cause.message}`,
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
      .catch((error) => this.#reportError("subscription", error, generation));
  }

  #report(diagnostic: WorkbenchTranscriptParityDiagnostic) {
    if (!this.#available) return;
    if (this.#lastDiagnostic && areDeeplyEqual(this.#lastDiagnostic, diagnostic)) return;
    this.#lastDiagnostic = diagnostic;
    const generation = this.#generation;
    this.#reporting = this.#reporting
      .then(async () => {
        if (this.#disposed || !this.#available || generation !== this.#generation) return;
        await this.#transcripts.reportParity(diagnostic);
      })
      .catch((error) => this.#reportError("report", error));
  }
}
