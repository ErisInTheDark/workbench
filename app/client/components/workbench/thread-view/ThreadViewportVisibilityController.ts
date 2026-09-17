/* Exports: default ThreadViewportVisibilityController shares viewport observation and measured visibility.
 * ThreadContentVisibility describes actual visibility and measured block height.
 * ThreadContentVisibilityRange selects exact viewport or nearby overscan observation.
 */
export interface ThreadContentVisibility {
  visible: boolean;
  height: number;
}

export type ThreadContentVisibilityRange = "nearby" | "viewport";

interface Observer {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

interface Observers {
  root: HTMLElement;
  intersection(
    callback: (entries: readonly { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } }[]) => void,
    range: ThreadContentVisibilityRange,
    rootMarginPx: number,
  ): Observer;
  resize(callback: (entries: readonly { target: Element }[]) => void): Observer;
}

export default class ThreadViewportVisibilityController {
  private readonly entries = new Map<HTMLElement, {
    state: ThreadContentVisibility;
    notify: (state: ThreadContentVisibility) => void;
    range: ThreadContentVisibilityRange;
  }>();
  private readonly observers: Observers;
  private readonly viewportIntersection: Observer;
  private nearbyIntersection: Observer;
  private nearbyIntersectionGeneration = 0;
  private readonly resize: Observer;
  private rootHeight: number;

  constructor(observers: Observers) {
    this.observers = observers;
    this.rootHeight = observers.root.getBoundingClientRect().height;
    this.viewportIntersection = observers.intersection(
      entries => this.receiveIntersections("viewport", entries),
      "viewport",
      0,
    );
    this.nearbyIntersection = this.createNearbyIntersection();
    this.resize = observers.resize(entries => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target === observers.root) {
          this.updateRootHeight();
          continue;
        }
        if (!this.entries.get(target)?.state.visible) continue;
        this.update(target, { visible: true, height: target.getBoundingClientRect().height });
      }
    });
    this.resize.observe(observers.root);
  }

  observe(
    target: HTMLElement,
    notify: (state: ThreadContentVisibility) => void,
    range: ThreadContentVisibilityRange = "viewport",
  ) {
    const state = { visible: true, height: target.getBoundingClientRect().height };
    this.entries.set(target, { state, notify, range });
    notify(state);
    this.intersectionFor(range).observe(target);
    this.resize.observe(target);
    return () => {
      this.entries.delete(target);
      this.intersectionFor(range).unobserve(target);
      this.resize.unobserve(target);
    };
  }

  dispose() {
    this.nearbyIntersection.disconnect();
    this.viewportIntersection.disconnect();
    this.resize.disconnect();
    this.entries.clear();
  }

  private createNearbyIntersection() {
    const generation = ++this.nearbyIntersectionGeneration;
    return this.observers.intersection((entries) => {
      if (generation !== this.nearbyIntersectionGeneration) return;
      this.receiveIntersections("nearby", entries);
    }, "nearby", this.rootHeight);
  }

  private intersectionFor(range: ThreadContentVisibilityRange) {
    return range === "nearby" ? this.nearbyIntersection : this.viewportIntersection;
  }

  private receiveIntersections(
    range: ThreadContentVisibilityRange,
    entries: readonly { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } }[],
  ) {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      const current = this.entries.get(target);
      if (!current || current.range !== range) continue;
      const height = current.state.visible && entry.boundingClientRect.height > 0
        ? entry.boundingClientRect.height : current.state.height;
      this.update(target, { visible: entry.isIntersecting || height === 0, height });
    }
  }

  private updateRootHeight() {
    const height = this.observers.root.getBoundingClientRect().height;
    if (height === this.rootHeight) return;
    this.rootHeight = height;
    const previous = this.nearbyIntersection;
    this.nearbyIntersection = this.createNearbyIntersection();
    for (const [target, entry] of this.entries) {
      if (entry.range === "nearby") this.nearbyIntersection.observe(target);
    }
    previous.disconnect();
  }

  private update(target: HTMLElement, state: ThreadContentVisibility) {
    const current = this.entries.get(target);
    if (!current || (state.visible === current.state.visible && state.height === current.state.height)) return;
    current.state = state;
    current.notify(state);
  }
}
