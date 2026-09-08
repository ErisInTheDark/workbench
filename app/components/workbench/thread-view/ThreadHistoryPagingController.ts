/*
 * Keywords: history, paging, scroll anchor, render commit, scheduling.
 * Exports:
 * - HistoryPagingView: current renderer and viewport measurements.
 * - HistoryPagingOptions: viewport, request, and scheduling boundary.
 * - default ThreadHistoryPagingController: own automatic paging and prepend restoration.
 */
import ThreadScrollMode, { type ThreadScrollMetrics, type ThreadScrollMode as ScrollMode } from "./thread-scroll-mode";

export interface HistoryPagingView {
  readonly identity: object;
  readonly viewport: object;
  readonly boundaryKey: string | null;
  readonly requestStatus: "loading" | "failed" | undefined;
  readonly sourceReady: boolean;
  readonly renderedTurnIds: readonly string[];
  readonly nearTop: boolean;
  readonly mode: ScrollMode;
  readonly metrics: ThreadScrollMetrics;
  readonly anchor: { readonly turnId: string; readonly top: number } | null;
  readonly anchorTop: (turnId: string) => number | null;
}

export interface HistoryPagingOptions {
  readonly readView: () => HistoryPagingView | null;
  readonly writeScrollTop: (scrollTop: number) => void;
  readonly load: () => void;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

interface PendingPrepend {
  readonly transaction: number;
  anchor: HistoryPagingView["anchor"];
  receivedTurnIds: readonly string[] | null;
}

interface ScheduledHistoryLoad {
  readonly boundaryKey: string;
  cancel: (() => void) | null;
}

const HISTORY_DWELL_MS = 500;

export default class ThreadHistoryPagingController {
  readonly #options: HistoryPagingOptions;
  #identity: object | null = null;
  #viewport: object | null = null;
  #triggeredBoundary: string | null = null;
  #pending: PendingPrepend | null = null;
  #scheduled: ScheduledHistoryLoad | null = null;
  #transaction = 0;
  #disposed = false;

  constructor(options: HistoryPagingOptions) {
    this.#options = options;
  }

  begin(): number | null {
    const view = this.#read();
    if (!view || this.#pending || !view.boundaryKey || view.requestStatus === "loading") return null;
    this.#cancelScheduled();
    this.#triggeredBoundary = view.boundaryKey;
    const transaction = ++this.#transaction;
    this.#pending = {
      transaction,
      anchor: view.anchor,
      receivedTurnIds: null,
    };
    return transaction;
  }

  succeed(transaction: number, receivedTurnIds: readonly string[]) {
    if (this.#pending?.transaction === transaction) this.#pending.receivedTurnIds = receivedTurnIds;
  }

  fail(transaction: number) {
    if (this.#pending?.transaction === transaction) this.#pending = null;
  }

  interrupt() {
    if (this.#pending) this.#pending.anchor = null;
    this.#cancelScheduled();
    this.reconcile();
  }

  reconcile() {
    let view = this.#read();
    if (!view) return;
    const pending = this.#pending;
    if (pending) {
      this.#cancelScheduled();
      const top = pending.anchor ? view.anchorTop(pending.anchor.turnId) : null;
      if (pending.anchor && top !== null && Math.abs(top - pending.anchor.top) > 0.5) {
        const offset = ThreadScrollMode.toTopOriginOffset(view.mode, view.metrics);
        this.#options.writeScrollTop(ThreadScrollMode.scrollTopForTopOriginOffset(
          view.mode, offset + top - pending.anchor.top, view.metrics,
        ));
      }
      const renderedTurnIds = view.renderedTurnIds;
      if (!pending.receivedTurnIds || !view.sourceReady
        || !pending.receivedTurnIds.every((id) => renderedTurnIds.includes(id))) return;
      this.#pending = null;
      view = this.#read();
      if (!view) return;
    }
    if (!view.nearTop) this.#triggeredBoundary = null;
    if (!this.#eligible(view)) {
      this.#cancelScheduled();
      return;
    }
    if (this.#scheduled?.boundaryKey === view.boundaryKey) return;
    this.#cancelScheduled();
    const scheduled: ScheduledHistoryLoad = { boundaryKey: view.boundaryKey!, cancel: null };
    this.#scheduled = scheduled;
    scheduled.cancel = this.#options.schedule(() => {
      if (this.#scheduled !== scheduled) return;
      const current = this.#read();
      if (this.#scheduled !== scheduled) return;
      this.#scheduled = null;
      if (current && current.boundaryKey === scheduled.boundaryKey && this.#eligible(current)) {
        this.#options.load();
      }
    }, HISTORY_DWELL_MS);
  }

  dispose() {
    this.#disposed = true;
    this.#cancelScheduled();
    this.#pending = null;
  }

  #eligible(view: HistoryPagingView) {
    return view.nearTop && view.sourceReady && Boolean(view.boundaryKey) && !view.requestStatus
      && !this.#pending && view.boundaryKey !== this.#triggeredBoundary;
  }

  #cancelScheduled() {
    this.#scheduled?.cancel?.();
    this.#scheduled = null;
  }

  #read() {
    if (this.#disposed) return null;
    const view = this.#options.readView();
    if (!view || view.identity !== this.#identity || view.viewport !== this.#viewport) {
      this.#cancelScheduled();
      this.#pending = null;
      this.#triggeredBoundary = null;
      this.#identity = view?.identity ?? null;
      this.#viewport = view?.viewport ?? null;
    }
    return view;
  }
}
