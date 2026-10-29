/*
 * Exports:
 * - ThreadComponentStylesState: current styles and failures for one thread view.
 * - default ThreadComponentStylesController: load and share active skill styles for one thread view.
 */
import { readThreadComponentStyle, type ThreadComponentStyle, type ThreadComponentStyleRevision } from "workbench-shared/workbench/thread/thread-component-tree";

export interface ThreadComponentStylesState {
  styles: readonly ThreadComponentStyle[];
  error: string | null;
}

export default class ThreadComponentStylesController {
  #state: ThreadComponentStylesState = { styles: [], error: null };
  #listeners = new Set<() => void>();
  #key: string | null = null;
  #enabled = false;
  #generation = 0;
  #flight: { controller: AbortController; promise: Promise<void> } | null = null;

  constructor(private readonly load: (signal: AbortSignal) => Promise<readonly ThreadComponentStyle[]>) {}

  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  snapshot = () => this.#state;

  #publish(state: ThreadComponentStylesState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  setSkills(key: string, enabled: boolean) {
    if (key === this.#key && enabled === this.#enabled) return;
    this.#key = key;
    this.#enabled = enabled;
    this.#generation += 1;
    this.#flight?.controller.abort();
    this.#flight = null;
    this.#publish({ styles: [], error: null });
    if (enabled) void this.refresh().catch(() => {});
  }

  refresh(): Promise<void> {
    if (!this.#enabled) return Promise.resolve();
    if (this.#flight) return this.#flight.promise;
    const generation = this.#generation;
    const controller = new AbortController();
    const promise = this.load(controller.signal).then(values => {
      if (generation !== this.#generation) return;
      this.#publish({ styles: values.map(readThreadComponentStyle), error: null });
    }).catch((error: unknown) => {
      if (generation !== this.#generation) return;
      this.#publish({ styles: [], error: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => {
      if (this.#flight?.controller === controller) this.#flight = null;
    });
    this.#flight = { controller, promise };
    return promise;
  }

  async ensure(revisions: readonly ThreadComponentStyleRevision[]) {
    const generation = this.#generation;
    if (this.#flight) await this.#flight.promise;
    if (generation !== this.#generation || !this.#enabled) return;
    if (this.#state.error) throw new Error(this.#state.error);
    if (revisions.some(revision => !this.#state.styles.some(style =>
      style.path === revision.path && style.revision === revision.revision))) {
      await this.refresh();
    }
  }

  dispose() {
    this.#generation += 1;
    this.#enabled = false;
    this.#flight?.controller.abort();
    this.#flight = null;
    this.#listeners.clear();
  }
}
