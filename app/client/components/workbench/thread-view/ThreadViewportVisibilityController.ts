/* Exports: default ThreadViewportVisibilityController shares viewport observation and measured visibility.
 * ThreadContentVisibility describes actual visibility and measured block height.
 */
export interface ThreadContentVisibility {
  visible: boolean;
  height: number;
}

interface Observer {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

interface Observers {
  intersection(callback: (entries: readonly { target: Element; isIntersecting: boolean; boundingClientRect: { height: number } }[]) => void): Observer;
  resize(callback: (entries: readonly { target: Element }[]) => void): Observer;
}

export default class ThreadViewportVisibilityController {
  private readonly entries = new Map<HTMLElement, { state: ThreadContentVisibility; notify: (state: ThreadContentVisibility) => void }>();
  private readonly intersection: Observer;
  private readonly resize: Observer;

  constructor(observers: Observers) {
    this.intersection = observers.intersection(entries => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const current = this.entries.get(target);
        if (!current) continue;
        const height = current.state.visible && entry.boundingClientRect.height > 0
          ? entry.boundingClientRect.height : current.state.height;
        this.update(target, { visible: entry.isIntersecting || height === 0, height });
      }
    });
    this.resize = observers.resize(entries => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (!this.entries.get(target)?.state.visible) continue;
        this.update(target, { visible: true, height: target.getBoundingClientRect().height });
      }
    });
  }

  observe(target: HTMLElement, notify: (state: ThreadContentVisibility) => void) {
    const state = { visible: true, height: target.getBoundingClientRect().height };
    this.entries.set(target, { state, notify });
    notify(state);
    this.intersection.observe(target);
    this.resize.observe(target);
    return () => {
      this.entries.delete(target);
      this.intersection.unobserve(target);
      this.resize.unobserve(target);
    };
  }

  dispose() {
    this.intersection.disconnect();
    this.resize.disconnect();
    this.entries.clear();
  }

  private update(target: HTMLElement, state: ThreadContentVisibility) {
    const current = this.entries.get(target);
    if (!current || (state.visible === current.state.visible && state.height === current.state.height)) return;
    current.state = state;
    current.notify(state);
  }
}
