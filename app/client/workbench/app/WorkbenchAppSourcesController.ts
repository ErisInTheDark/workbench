/*
 * Exports:
 * - default WorkbenchAppSourcesController: retry missing initial app sources with one disposable schedule.
 */
type Timer = number | ReturnType<typeof setTimeout>;

export default class WorkbenchAppSourcesController {
  private started = false;
  private disposed = false;
  private reading: Promise<void> | null = null;
  private timer: Timer | null = null;
  private failures = 0;

  constructor(private readonly options: {
    network: { start(): Promise<void>; snapshot(): { snapshot: object | null } };
    presentation: { refresh(): Promise<unknown>; snapshot(): { data: object | null } };
    schedule?: (callback: () => void, delayMs: number) => Timer;
    cancel?: (timer: Timer) => void;
    onError?: (error: unknown) => void;
  }) {}

  start() {
    if (this.disposed || this.started) return;
    this.started = true;
    void this.read();
  }

  private read(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.reading) return this.reading;
    const reads: Promise<unknown>[] = [];
    if (!this.options.network.snapshot().snapshot) reads.push(this.options.network.start());
    if (!this.options.presentation.snapshot().data) reads.push(this.options.presentation.refresh());
    if (!reads.length) {
      this.failures = 0;
      return Promise.resolve();
    }
    const operation = Promise.allSettled(reads).then(results => {
      if (this.disposed) return;
      for (const result of results) {
        if (result.status === "rejected") this.options.onError?.(result.reason);
      }
      if (this.options.network.snapshot().snapshot && this.options.presentation.snapshot().data) {
        this.failures = 0;
        return;
      }
      const delay = Math.min(30_000, 250 * 2 ** Math.min(this.failures++, 7));
      this.timer = (this.options.schedule ?? setTimeout)(() => {
        this.timer = null;
        void this.read();
      }, delay);
    }).finally(() => {
      if (this.reading === operation) this.reading = null;
    });
    this.reading = operation;
    return operation;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) (this.options.cancel ?? clearTimeout)(this.timer);
    this.timer = null;
  }
}
