/*
 * Exports:
 * - ProgressiveWindowView: current progressive-window geometry and hidden content count.
 * - ProgressiveWindowOptions: reading, revealing, and scroll-restoration boundary.
 * - default ThreadProgressiveWindowController: own bounded prepends, deferred while reader scrolling is unsettled, and pre-paint anchor restoration.
 */

export interface ProgressiveWindowView {
  readonly anchor: { readonly id: string; readonly top: number } | null;
  readonly anchorTop: (id: string) => number | null;
  readonly hiddenCount: number;
  readonly identity: object;
  readonly nearTop: boolean;
  readonly scrollTop: number;
  /** False during reader touch or momentum; iOS halts or yanks a fling when scrollTop is restored mid-flight. */
  readonly settled: boolean;
  readonly viewport: object;
}

export interface ProgressiveWindowOptions {
  readonly readView: () => ProgressiveWindowView | null;
  readonly reveal: (count: number) => void;
  readonly writeScrollTop: (scrollTop: number) => void;
}

const REVEAL_BATCH_SIZE = 4;

interface PendingPrepend {
  anchor: NonNullable<ProgressiveWindowView["anchor"]>;
  hiddenCount: number;
}

export default class ThreadProgressiveWindowController {
  readonly #options: ProgressiveWindowOptions;
  #identity: object | null = null;
  #pending: PendingPrepend | null = null;
  #viewport: object | null = null;

  constructor(options: ProgressiveWindowOptions) {
    this.#options = options;
  }

  reconcile() {
    let view = this.#read();
    if (!view) return;

    if (this.#pending) {
      if (view.hiddenCount >= this.#pending.hiddenCount) return;
      const top = view.anchorTop(this.#pending.anchor.id);
      if (top !== null && Math.abs(top - this.#pending.anchor.top) > 0.5) {
        this.#options.writeScrollTop(view.scrollTop + top - this.#pending.anchor.top);
      }
      this.#pending = null;
      view = this.#read();
      if (!view) return;
    }

    if (!view.settled || !view.nearTop || view.hiddenCount <= 0 || !view.anchor) return;
    this.#pending = { anchor: view.anchor, hiddenCount: view.hiddenCount };
    this.#options.reveal(Math.min(REVEAL_BATCH_SIZE, view.hiddenCount));
  }

  #read() {
    const view = this.#options.readView();
    if (!view || view.identity !== this.#identity || view.viewport !== this.#viewport) {
      this.#pending = null;
      this.#identity = view?.identity ?? null;
      this.#viewport = view?.viewport ?? null;
    }
    return view;
  }
}
