/*
 * Exports:
 * - default ThreadActivityRunController: subscribable record of which activity runs are expanded, surviving scroll-windowing
 *   remounts; runs start closed unless the controller opens them by default.
 */

export default class ThreadActivityRunController {
  readonly #defaultOpen: boolean;
  /** Runs toggled away from the default. */
  readonly #toggled = new Set<string>();
  readonly #listeners = new Set<() => void>();

  constructor({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
    this.#defaultOpen = defaultOpen;
  }

  isOpen(identity: string) {
    return this.#toggled.has(identity) !== this.#defaultOpen;
  }

  setOpen(identity: string, open: boolean) {
    if (open === this.isOpen(identity)) return;
    if (this.#toggled.has(identity)) this.#toggled.delete(identity);
    else this.#toggled.add(identity);
    for (const listener of this.#listeners) listener();
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
