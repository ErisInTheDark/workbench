/*
 * Exports:
 * - default ThreadActivityRunController: subscribable record of which activity runs are expanded, surviving scroll-windowing remounts.
 */

export default class ThreadActivityRunController {
  readonly #open = new Set<string>();
  readonly #listeners = new Set<() => void>();

  isOpen(identity: string) {
    return this.#open.has(identity);
  }

  setOpen(identity: string, open: boolean) {
    if (open === this.#open.has(identity)) return;
    if (open) this.#open.add(identity);
    else this.#open.delete(identity);
    for (const listener of this.#listeners) listener();
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
