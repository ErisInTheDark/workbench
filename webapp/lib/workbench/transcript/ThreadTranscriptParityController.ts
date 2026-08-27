/*
 * ThreadTranscriptParitySelection: selected JSON oracle and renderer-side Browse facts. Keywords: transcript, parity, selection.
 * default ThreadTranscriptParityController: owns one serialized selected-thread subscription and deduplicated semantic mismatch reporting. Keywords: transcript, subscription, parity, lifecycle.
 */
import type { ThreadPayload, WorkbenchBrowseResultEntry } from "../../types";
import type WorkbenchTranscriptClient from "../database/transcript/WorkbenchTranscriptClient";
import type {
  WorkbenchTranscriptParityDiagnostic,
  WorkbenchTranscriptSnapshot,
} from "../database/transcript/workbench-transcript-contract";
import { areDeeplyEqual } from "../deep-equality";
import {
  compareWorkbenchTranscriptParity,
  createWorkbenchTranscriptProjectionFailureDiagnostic,
} from "./thread-transcript-parity";
import {
  projectWorkbenchTranscript,
  type WorkbenchTranscriptProjection,
} from "./workbench-transcript-projection";

export interface ThreadTranscriptParitySelection {
  browseResultEntries: readonly WorkbenchBrowseResultEntry[];
  thread: ThreadPayload;
}

function sameTurnIds(
  left: readonly { id: string }[] | null | undefined,
  right: readonly { id: string }[] | null | undefined,
) {
  return (left?.length ?? 0) === (right?.length ?? 0)
    && (left ?? []).every((turn, index) => turn.id === right?.[index]?.id);
}

interface ThreadTranscriptParityControllerOptions {
  available?: boolean;
  onError?: (error: Error) => void;
  reconcileProjection?: (
    projection: WorkbenchTranscriptProjection,
    selection: ThreadTranscriptParitySelection,
  ) => WorkbenchTranscriptProjection;
  transcripts: Pick<WorkbenchTranscriptClient, "reportParity" | "subscribe" | "unsubscribe">;
  turnLimit: number;
}

export default class ThreadTranscriptParityController {
  readonly #onError: NonNullable<ThreadTranscriptParityControllerOptions["onError"]>;
  readonly #reconcileProjection: NonNullable<ThreadTranscriptParityControllerOptions["reconcileProjection"]>;
  readonly #transcripts: ThreadTranscriptParityControllerOptions["transcripts"];
  readonly #turnLimit: number;
  #activeSubscriptionId: string | null = null;
  #available: boolean;
  #disposed = false;
  #generation = 0;
  #lastDiagnostic: WorkbenchTranscriptParityDiagnostic | null = null;
  #lifecycle = Promise.resolve();
  #projection: WorkbenchTranscriptProjection | null = null;
  #reporting = Promise.resolve();
  #selection: ThreadTranscriptParitySelection | null = null;

  constructor({
    available = false,
    onError = (error) => console.error("Workbench transcript parity failed.", error),
    reconcileProjection = (projection) => projection,
    transcripts,
    turnLimit,
  }: ThreadTranscriptParityControllerOptions) {
    this.#onError = onError;
    this.#available = available;
    this.#reconcileProjection = reconcileProjection;
    this.#transcripts = transcripts;
    this.#turnLimit = turnLimit;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#selection = null;
    this.#projection = null;
    this.#lastDiagnostic = null;
    this.#generation += 1;
    this.#activeSubscriptionId = null;
  }

  setAvailable(available: boolean) {
    if (this.#disposed || this.#available === available) return;
    this.#available = available;
    this.#projection = null;
    this.#lastDiagnostic = null;
    if (!available) {
      this.#generation += 1;
      this.#activeSubscriptionId = null;
      return;
    }
    this.#replaceSubscription();
  }

  select(selection: ThreadTranscriptParitySelection | null) {
    if (this.#disposed) return;
    const previousThreadId = this.#selection?.thread.id ?? null;
    const nextThreadId = selection?.thread.id ?? null;
    const loadedTurnsChanged = !sameTurnIds(this.#selection?.thread.turns, selection?.thread.turns);
    this.#selection = selection;
    if (previousThreadId !== nextThreadId || loadedTurnsChanged) {
      this.#projection = null;
      this.#lastDiagnostic = null;
      if (!this.#available) {
        this.#generation += 1;
        this.#activeSubscriptionId = null;
        return;
      }
      this.#replaceSubscription();
      return;
    }
    this.#compare();
  }

  #compare() {
    if (!this.#selection || !this.#projection) return;
    let projection: WorkbenchTranscriptProjection;
    try {
      projection = this.#reconcileProjection(this.#projection, this.#selection);
    } catch (error) {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
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

  #receiveSnapshot(generation: number, snapshot: WorkbenchTranscriptSnapshot | null) {
    if (this.#disposed || generation !== this.#generation) return;
    if (snapshot === null) {
      this.#projection = null;
      this.#lastDiagnostic = null;
      return;
    }
    if (snapshot.thread.id !== this.#selection?.thread.id) return;
    const result = projectWorkbenchTranscript(snapshot);
    if ("issues" in result) {
      this.#projection = null;
      this.#report(createWorkbenchTranscriptProjectionFailureDiagnostic(snapshot.thread.id, result.issues));
      return;
    }
    this.#projection = result.data;
    this.#compare();
  }

  #reportError(error: unknown) {
    if (this.#disposed || !this.#available) return;
    this.#onError(error instanceof Error ? error : new Error(String(error)));
  }

  #replaceSubscription() {
    const generation = ++this.#generation;
    const selection = this.#selection;
    this.#lifecycle = this.#lifecycle
      .then(async () => {
        if (this.#disposed || !this.#available) {
          this.#activeSubscriptionId = null;
          return;
        }
        if (this.#activeSubscriptionId) {
          const activeSubscriptionId = this.#activeSubscriptionId;
          this.#activeSubscriptionId = null;
          await this.#transcripts.unsubscribe({ subscriptionId: activeSubscriptionId });
        }
        if (this.#disposed || !this.#available || generation !== this.#generation || !selection) return;
        const subscriptionId = `thread-transcript-parity:${generation}`;
        this.#activeSubscriptionId = subscriptionId;
        await this.#transcripts.subscribe({
          subscriptionId,
          threadId: selection.thread.id,
          turnIds: selection.thread.turns.map(({ id }) => id),
          turnLimit: this.#turnLimit,
        }, (snapshot) => this.#receiveSnapshot(generation, snapshot));
        if (this.#disposed) {
          if (this.#activeSubscriptionId === subscriptionId) this.#activeSubscriptionId = null;
        } else if (generation !== this.#generation) {
          if (this.#activeSubscriptionId === subscriptionId) this.#activeSubscriptionId = null;
          await this.#transcripts.unsubscribe({ subscriptionId });
        }
      })
      .catch((error) => this.#reportError(error));
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
      .catch((error) => this.#reportError(error));
  }
}
