/*
 * Exports:
 * - default MobileShellHeaderVisibilityController: own mobile shell header visibility outside React state, notifying only when visibility flips.
 */
import {
  advanceMobileShellHeaderVisibility,
  type MobileShellHeaderEvent,
  type MobileShellHeaderVisibility,
} from "./mobile-shell-header-visibility";

function initialVisibility(lastScroll: MobileShellHeaderVisibility["lastScroll"]): MobileShellHeaderVisibility {
  return { visible: true, direction: null, travelPx: 0, lastScroll, gestureSinceLastScroll: false, touchPhase: "none" };
}

// Gesture events arrive many times per frame; keeping them out of the app root stops every flip re-rendering the whole app.
export default class MobileShellHeaderVisibilityController {
  readonly #listeners = new Set<() => void>();
  #state = initialVisibility(null);

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  readonly getVisible = () => this.#state.visible;

  apply(event: MobileShellHeaderEvent) {
    this.#commit(advanceMobileShellHeaderVisibility(this.#state, event));
  }

  reset(lastScroll: MobileShellHeaderVisibility["lastScroll"]) {
    this.#commit(initialVisibility(lastScroll));
  }

  #commit(next: MobileShellHeaderVisibility) {
    const changed = next.visible !== this.#state.visible;
    this.#state = next;
    if (changed) for (const listener of [...this.#listeners]) listener();
  }
}
