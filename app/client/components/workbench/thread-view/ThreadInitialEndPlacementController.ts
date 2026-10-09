/*
 * Exports:
 * - default ThreadInitialEndPlacementController: keep initial layout commits bottom-aligned until reader intent releases them.
 */

import { getInitialThreadScrollTop } from "./thread-scroll-snap";

export default class ThreadInitialEndPlacementController {
  #released = false;

  getScrollTop(hasEndTarget: boolean, scrollHeight: number) {
    return this.#released ? null : getInitialThreadScrollTop(hasEndTarget, scrollHeight);
  }

  release() {
    this.#released = true;
  }
}
