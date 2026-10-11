/*
 * Exports:
 * - ProgressiveWindowView: current progressive-window reach and hidden content count.
 * - ProgressiveWindowOptions: reading and revealing boundary.
 * - default ThreadProgressiveWindowController: own bounded prepends while the reader nears the window's top.
 */

export interface ProgressiveWindowView {
  readonly hiddenCount: number;
  readonly identity: object;
  readonly nearTop: boolean;
  readonly viewport: object;
}

export interface ProgressiveWindowOptions {
  readonly readView: () => ProgressiveWindowView | null;
  readonly reveal: (count: number) => void;
}

const REVEAL_BATCH_SIZE = 4;

export default class ThreadProgressiveWindowController {
  readonly #options: ProgressiveWindowOptions;
  #identity: object | null = null;
  /** Hidden count when the last reveal was requested; no further reveal until React commits it. */
  #pendingHiddenCount: number | null = null;
  #viewport: object | null = null;

  constructor(options: ProgressiveWindowOptions) {
    this.#options = options;
  }

  reconcile() {
    const view = this.#read();
    if (!view) return;
    if (this.#pendingHiddenCount !== null) {
      if (view.hiddenCount >= this.#pendingHiddenCount) return;
      this.#pendingHiddenCount = null;
    }
    if (!view.nearTop || view.hiddenCount <= 0) return;
    this.#pendingHiddenCount = view.hiddenCount;
    this.#options.reveal(Math.min(REVEAL_BATCH_SIZE, view.hiddenCount));
  }

  #read() {
    const view = this.#options.readView();
    if (!view || view.identity !== this.#identity || view.viewport !== this.#viewport) {
      this.#pendingHiddenCount = null;
      this.#identity = view?.identity ?? null;
      this.#viewport = view?.viewport ?? null;
    }
    return view;
  }
}
