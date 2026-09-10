/*
 * Keywords: transcript, snapshot freshness, subscription, parity.
 * Exports:
 * ThreadTranscriptProjectionSelection: selected JSON oracle and renderer-side Browse facts. Keywords: transcript, parity, selection.
 * ThreadTranscriptProjectionState: explicit SQLite transcript source lifecycle. Keywords: transcript, projection, source, lifecycle.
 * default ThreadTranscriptProjectionController: owns SQLite source publication, serialized subscription, and deferred parity reporting. Keywords: transcript, projection, subscription, parity, lifecycle.
 */
import type { ThreadPayload, WorkbenchBrowseResultEntry } from "workbench-shared/types";
import type WorkbenchTranscriptClient from "../database/transcript/WorkbenchTranscriptClient";
import type {
  WorkbenchTranscriptParityDiagnostic,
  WorkbenchTranscriptSnapshot,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { getWorkbenchTurnAdmission, type WorkbenchAdmissionTurn } from "workbench-shared/workbench/thread/thread-admission";
import {
  compareWorkbenchTranscriptParity,
  createWorkbenchTranscriptProjectionFailureDiagnostic,
} from "./thread-transcript-parity";
import {
  projectWorkbenchTranscript,
  type WorkbenchTranscriptProjection,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";

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

interface ThreadTranscriptProjectionControllerOptions {
  available?: boolean;
  cancelComparison?: (timer: ReturnType<typeof setTimeout>) => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: ThreadTranscriptProjectionState) => void;
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

  constructor({
    available = false,
    cancelComparison = (timer) => clearTimeout(timer),
    onError = (error) => console.error("Workbench transcript projection failed.", error),
    onStateChange = () => undefined,
    reconcileProjection = (projection) => projection,
    scheduleComparison = (callback) => setTimeout(callback, 0),
    transcripts,
    turnLimit,
  }: ThreadTranscriptProjectionControllerOptions) {
    this.#cancelComparison = cancelComparison;
    this.#onError = onError;
    this.#onStateChange = onStateChange;
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
    const loadedTurnsChanged = !sameDurableTurnIds(this.#selection?.thread.turns, selection?.thread.turns);
    this.#selection = selection;
    if (previousThreadId !== nextThreadId) {
      this.#cancelScheduledComparison();
      this.#projection = null;
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
    if (publishState) this.#publishProjection();
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
        }, (snapshot) => this.#receiveSnapshot(generation, snapshot));
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
