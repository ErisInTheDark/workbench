/*
 * Exports:
 * - ThreadScrollSettleOptions: idle scheduling, scroll, reserve, and content-offset boundary.
 * - default ThreadScrollSettleController: own every reading-position correction. In flight (touch or momentum) a correction
 *   spends a reserved spacer above the content instead of writing scrollTop; at rest the reserve is refilled with one scroll.
 *   Readers are caught at the loaded top so they never scroll into the reserve.
 */

export interface ThreadScrollSettleOptions {
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  /** Current scroll position; a main-thread stall can delay scroll events while momentum keeps moving it. */
  readonly readScrollTop: () => number;
  /** Move the scroll position by a delta; in flight only to put a reader who crossed into the reserve back at the top. */
  readonly scrollBy: (delta: number) => void;
  /** Height in px of the empty spacer above the content. */
  readonly setReserve: (heightPx: number) => void;
  /** Desired reserve height at rest: large while more content can arrive above, 0 at the true top. */
  readonly readReserveTarget: () => number;
  /** Offset content layout in px (negative moves content up); 0 clears it. Fallback once the reserve is spent. */
  readonly setContentOffset: (offsetPx: number) => void;
  /** Stop and block scrolling (iOS ends momentum when its scroller stops overflowing), or release it. */
  readonly setScrollLocked: (locked: boolean) => void;
}

// iOS Safari has no scrollend: momentum counts as finished once scroll events stop for this long.
// This defines "settled", not a failure deadline; late scroll events simply re-arm it.
const THREAD_SCROLL_MOMENTUM_IDLE_MS = 150;
// Long enough for the scroller to drop the killed momentum before it can scroll again.
const THREAD_SCROLL_CATCH_RELEASE_MS = 50;

export default class ThreadScrollSettleController {
  readonly #options: ThreadScrollSettleOptions;
  #cancelIdle: (() => void) | null = null;
  #momentum = false;
  #touching = false;
  #reserve = 0;
  /** Growth above the reader that outran the reserve, held as negative content offset until settle. */
  #overflow = 0;
  #lastScrollTop = 0;
  #locked = false;
  #cancelRelease: (() => void) | null = null;

  constructor(options: ThreadScrollSettleOptions) {
    this.#options = options;
  }

  get settled() {
    return !this.#touching && !this.#momentum;
  }

  /** Bring the reserve to its target now when settled; in flight it waits for settle. */
  reconcileReserve() {
    if (this.settled) this.#rest(0);
  }

  /**
   * Keep the reader's visual position after layout above them changed by `delta`; returns how much was applied, less
   * than asked only when a settled scroll hits its edge. iOS ignores or halts a fling on scrollTop writes mid-gesture,
   * so in flight the same delta comes out of the reserve above the content instead: the new content takes the reserve's
   * place and nothing the reader sees moves.
   */
  shift(delta: number) {
    if (!delta) return 0;
    if (this.settled) {
      const before = this.#options.readScrollTop();
      this.#options.scrollBy(delta);
      return this.#options.readScrollTop() - before;
    }
    // Shrinking content first repays overflow; growth spends the reserve, and only what it cannot cover overflows.
    const repaid = delta < 0 ? Math.min(-delta, this.#overflow) : 0;
    const remaining = delta + repaid;
    const spent = remaining > 0 ? Math.min(remaining, this.#reserve) : remaining;
    const overflow = this.#overflow - repaid + remaining - spent;
    if (spent) {
      this.#reserve -= spent;
      this.#options.setReserve(this.#reserve);
    }
    if (overflow !== this.#overflow) {
      this.#overflow = overflow;
      this.#options.setContentOffset(overflow ? -overflow : 0);
    }
    return delta;
  }

  touchStarted() {
    this.#clearIdle();
    this.#touching = true;
    this.#lastScrollTop = this.#options.readScrollTop();
  }

  /** A lifted finger may hand off to momentum, so settling waits for scroll to go quiet. */
  touchEnded() {
    if (!this.#touching) return;
    this.#touching = false;
    this.#momentum = true;
    // A drag caught at the loaded top stays caught until the finger lifts.
    if (this.#locked && !this.#cancelRelease) this.#release();
    this.#armIdle();
  }

  scrolled() {
    const scrollTop = this.#options.readScrollTop();
    const upward = this.#lastScrollTop - scrollTop;
    this.#lastScrollTop = scrollTop;
    // The reserve is blank room for arriving history, never somewhere to read: catch the reader at the loaded
    // top on the frame before they would cross into it, rather than writing scrollTop after they have.
    if (!this.settled && !this.#locked && this.#reserve > 0 && upward > 0 && scrollTop - upward <= this.#reserve) {
      this.#catch();
    }
    // Momentum the lock did not stop in time already crossed: put the reader back before that frame paints, a stop at
    // the top instead of blank reserve and a bounce back at settle. A scroller that ignores the write is repaid at rest.
    if (!this.settled && scrollTop < this.#reserve) {
      this.#options.scrollBy(this.#reserve - scrollTop);
      this.#lastScrollTop = this.#options.readScrollTop();
    }
    if (this.#momentum) this.#armIdle();
  }

  scrollEnded() {
    if (!this.#touching && this.#momentum) this.#settle();
  }

  dispose() {
    this.#clearIdle();
    this.#cancelRelease?.();
    this.#cancelRelease = null;
    if (this.#locked) this.#release();
  }

  #catch() {
    this.#locked = true;
    this.#options.setScrollLocked(true);
    if (this.#touching) return;
    this.#cancelRelease = this.#options.schedule(() => {
      this.#cancelRelease = null;
      this.#release();
    }, THREAD_SCROLL_CATCH_RELEASE_MS);
  }

  #release() {
    this.#locked = false;
    this.#options.setScrollLocked(false);
  }

  #armIdle() {
    this.#clearIdle();
    const armedAt = this.#options.readScrollTop();
    this.#cancelIdle = this.#options.schedule(() => {
      this.#cancelIdle = null;
      // Still moving with its scroll events stuck behind a long task: not settled yet.
      if (this.#options.readScrollTop() !== armedAt) this.#armIdle();
      else this.#settle();
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
    const overflow = this.#overflow;
    this.#overflow = 0;
    if (overflow) this.#options.setContentOffset(0);
    this.#rest(overflow);
  }

  /**
   * Refill the reserve and repay any overflow in one scroll; same task, no paint between, so nothing visibly moves.
   * A reader who overshot into the reserve is brought back to the loaded top in the same scroll.
   */
  #rest(pending: number) {
    const target = Math.max(0, this.#options.readReserveTarget());
    const refill = target - this.#reserve;
    if (refill) {
      this.#reserve = target;
      this.#options.setReserve(this.#reserve);
    }
    const restingTop = this.#options.readScrollTop() + pending + refill;
    const overshoot = this.#reserve > 0 && restingTop < this.#reserve ? this.#reserve - restingTop : 0;
    if (pending + refill + overshoot) this.#options.scrollBy(pending + refill + overshoot);
  }
}
