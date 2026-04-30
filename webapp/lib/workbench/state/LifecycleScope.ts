/*
 * Exports:
 * - LifecycleTaskCallback: callback shape for named lifecycle-owned scheduled work. Keywords: workbench, lifecycle, callback, scheduling.
 * - default LifecycleScope: client-local owner for abortable listeners, named timers, named animation frames, and unsubscribe callbacks. Keywords: workbench, lifecycle, cleanup, timers, animation frame, abort, dispose, default export.
 */

export type LifecycleTaskCallback = () => void | Promise<void>;

type LifecycleScheduledTask =
  | {
      kind: "animation-frame";
      frameId: number;
    }
  | {
      kind: "timeout";
      timeoutId: number;
    }
  | {
      active: boolean;
      callback: LifecycleTaskCallback;
      delay: number;
      kind: "repeat";
      timeoutId: number | null;
    };

export default class LifecycleScope {
  private readonly abortController = new AbortController();
  private readonly scheduledTasks = new Map<string, LifecycleScheduledTask>();
  private readonly unsubscribes = new Set<() => void>();
  private disposed = false;

  get isDisposed() {
    return this.disposed;
  }

  getSignal() {
    return this.abortController.signal;
  }

  has(id: string) {
    return this.scheduledTasks.has(id);
  }

  addUnsubscribe(unsubscribe: () => void) {
    if (this.disposed) {
      unsubscribe();
      return;
    }

    this.unsubscribes.add(unsubscribe);
  }

  scheduleAnimationFrame(id: string, callback: () => void) {
    if (this.disposed) {
      return;
    }

    this.cancel(id);
    const frameId = window.requestAnimationFrame(() => {
      const scheduledTask = this.scheduledTasks.get(id);
      if (!scheduledTask || scheduledTask.kind !== "animation-frame") {
        return;
      }

      this.scheduledTasks.delete(id);
      callback();
    });

    this.scheduledTasks.set(id, {
      kind: "animation-frame",
      frameId,
    });
  }

  scheduleOnce(id: string, delay: number, callback: () => void) {
    if (this.disposed) {
      return;
    }

    this.cancel(id);
    const timeoutId = window.setTimeout(() => {
      const scheduledTask = this.scheduledTasks.get(id);
      if (!scheduledTask || scheduledTask.kind !== "timeout") {
        return;
      }

      this.scheduledTasks.delete(id);
      callback();
    }, delay);

    this.scheduledTasks.set(id, {
      kind: "timeout",
      timeoutId,
    });
  }

  scheduleRepeat(id: string, delay: number, callback: LifecycleTaskCallback) {
    if (this.disposed) {
      return;
    }

    this.cancel(id);
    const scheduledTask: Extract<LifecycleScheduledTask, { kind: "repeat" }> = {
      active: true,
      callback,
      delay,
      kind: "repeat",
      timeoutId: null,
    };

    const scheduleNext = () => {
      if (this.disposed || !scheduledTask.active) {
        return;
      }

      scheduledTask.timeoutId = window.setTimeout(() => {
        scheduledTask.timeoutId = null;
        void run();
      }, scheduledTask.delay);
      this.scheduledTasks.set(id, scheduledTask);
    };

    const run = async () => {
      if (this.disposed || !scheduledTask.active) {
        return;
      }

      try {
        await scheduledTask.callback();
      } finally {
        if (!this.disposed && scheduledTask.active && this.scheduledTasks.get(id) === scheduledTask) {
          scheduleNext();
        }
      }
    };

    scheduleNext();
  }

  cancel(id: string) {
    const scheduledTask = this.scheduledTasks.get(id);
    if (!scheduledTask) {
      return;
    }

    this.scheduledTasks.delete(id);

    if (scheduledTask.kind === "animation-frame") {
      window.cancelAnimationFrame(scheduledTask.frameId);
      return;
    }

    if (scheduledTask.kind === "timeout") {
      window.clearTimeout(scheduledTask.timeoutId);
      return;
    }

    scheduledTask.active = false;
    if (scheduledTask.timeoutId !== null) {
      window.clearTimeout(scheduledTask.timeoutId);
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    for (const id of this.scheduledTasks.keys()) {
      this.cancel(id);
    }

    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes.clear();
    this.abortController.abort();
  }
}