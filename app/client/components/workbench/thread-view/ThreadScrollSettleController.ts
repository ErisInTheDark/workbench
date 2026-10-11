/*
 * Exports:
 * - ThreadScrollSettleOptions: idle scheduling boundary.
 * - default ThreadScrollSettleController: track whether reader touch scrolling, including momentum, has settled.
 */

export interface ThreadScrollSettleOptions {
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

// iOS Safari has no scrollend: momentum counts as finished once scroll events stop for this long.
// This defines "settled", not a failure deadline; late scroll events simply re-arm it.
const THREAD_SCROLL_MOMENTUM_IDLE_MS = 150;

export default class ThreadScrollSettleController {
  readonly #listeners = new Set<() => void>();
  readonly #options: ThreadScrollSettleOptions;
  #cancelIdle: (() => void) | null = null;
  #momentum = false;
  #touching = false;

  constructor(options: ThreadScrollSettleOptions) {
    this.#options = options;
  }

  get settled() {
    return !this.#touching && !this.#momentum;
  }

  touchStarted() {
    this.#clearIdle();
    this.#touching = true;
  }

  /** A lifted finger may hand off to momentum, so settling waits for scroll to go quiet. */
  touchEnded() {
    if (!this.#touching) return;
    this.#touching = false;
    this.#momentum = true;
    this.#armIdle();
  }

  scrolled() {
    if (this.#momentum) this.#armIdle();
  }

  scrollEnded() {
    if (!this.#touching && this.#momentum) this.#settle();
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  dispose() {
    this.#clearIdle();
    this.#listeners.clear();
  }

  #armIdle() {
    this.#clearIdle();
    this.#cancelIdle = this.#options.schedule(() => {
      this.#cancelIdle = null;
      this.#settle();
    }, THREAD_SCROLL_MOMENTUM_IDLE_MS);
  }

  #clearIdle() {
    this.#cancelIdle?.();
    this.#cancelIdle = null;
  }

  #settle() {
    this.#clearIdle();
    if (!this.#momentum) return;
    this.#momentum = false;
    for (const listener of [...this.#listeners]) listener();
  }
}
