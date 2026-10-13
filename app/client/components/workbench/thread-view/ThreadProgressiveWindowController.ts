/*
 * Exports:
 * - ProgressiveWindowView: current progressive-window geometry and hidden content count.
 * - ProgressiveWindowOptions: reading and revealing boundary.
 * - default ThreadProgressiveWindowController: own bounded prepends until a window the reader nears or passed is whole.
 */
import {
  ROUTINE_THREAD_WINDOW_CHUNKS,
  URGENT_THREAD_WINDOW_CHUNKS,
} from "./thread-progressive-window-policy";

export interface ProgressiveWindowView {
  readonly hiddenCount: number;
  readonly identity: object;
  /** Bottom of the window's top sentinel, in the same client coordinates as `viewportTop`. */
  readonly sentinelBottom: number;
  readonly viewport: object;
  readonly viewportHeight: number;
  readonly viewportTop: number;
}

export interface ProgressiveWindowOptions {
  readonly readView: () => ProgressiveWindowView | null;
  readonly reveal: (count: number) => void;
}

const REVEAL_LOOKAHEAD_SCREENS = 2;

export default class ThreadProgressiveWindowController {
  readonly #options: ProgressiveWindowOptions;
  #identity: object | null = null;
  /**
   * Hidden count when the last reveal was requested; no further reveal until it changes. Chunks landing above can
   * raise it while the reveal commits, so any change ends the wait, not only a drop.
   */
  #pendingHiddenCount: number | null = null;
  #viewport: object | null = null;

  constructor(options: ProgressiveWindowOptions) {
    this.#options = options;
  }

  /**
   * A window the reader scrolled past keeps revealing: stopping once its sentinel leaves the bottom of the viewport
   * would leave a permanent hole between it and the content above.
   */
  reconcile() {
    const view = this.#read();
    if (!view) return;
    if (this.#pendingHiddenCount !== null) {
      if (view.hiddenCount === this.#pendingHiddenCount) return;
      this.#pendingHiddenCount = null;
    }
    if (view.hiddenCount <= 0) return;
    if (view.sentinelBottom <= view.viewportTop - REVEAL_LOOKAHEAD_SCREENS * view.viewportHeight) return;
    const batch = view.sentinelBottom > view.viewportTop ? URGENT_THREAD_WINDOW_CHUNKS : ROUTINE_THREAD_WINDOW_CHUNKS;
    this.#pendingHiddenCount = view.hiddenCount;
    this.#options.reveal(Math.min(batch, view.hiddenCount));
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
