/*
 * Exports:
 * - WorkbenchBrowserResumeControllerOptions: reconnect, failure, and visibility ports for browser resume recovery. Keywords: browser, visibility, reconnect, lifecycle.
 * - default WorkbenchBrowserResumeController: serialize hidden-to-visible reconnect requests and own their cleanup. Keywords: browser, resume, visibility, reconnect, lifecycle.
 */

export interface WorkbenchBrowserResumeControllerOptions {
  onError?: (error: unknown) => void;
  reconnect: () => void | Promise<void>;
  visibility?: {
    hidden(): boolean;
    subscribe(listener: () => void): () => void;
  };
}

function browserVisibility(): NonNullable<WorkbenchBrowserResumeControllerOptions["visibility"]> {
  return {
    hidden: () => typeof document !== "undefined" && document.hidden,
    subscribe: (listener) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

export default class WorkbenchBrowserResumeController {
  readonly #onError: NonNullable<WorkbenchBrowserResumeControllerOptions["onError"]>;
  readonly #reconnect: WorkbenchBrowserResumeControllerOptions["reconnect"];
  readonly #visibility: NonNullable<WorkbenchBrowserResumeControllerOptions["visibility"]>;
  #disposed = false;
  #resumePending = false;
  #resumeTask: Promise<void> | null = null;
  #unsubscribe: (() => void) | null = null;
  #wasHidden: boolean;

  constructor({
    onError = () => undefined,
    reconnect,
    visibility = browserVisibility(),
  }: WorkbenchBrowserResumeControllerOptions) {
    this.#onError = onError;
    this.#reconnect = reconnect;
    this.#visibility = visibility;
    this.#wasHidden = visibility.hidden();
  }

  start() {
    if (this.#disposed || this.#unsubscribe) return;
    this.#wasHidden = this.#visibility.hidden();
    this.#unsubscribe = this.#visibility.subscribe(() => this.#handleVisibilityChange());
  }

  dispose() {
    this.#disposed = true;
    this.#resumePending = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #handleVisibilityChange() {
    if (this.#disposed) return;
    if (this.#visibility.hidden()) {
      this.#wasHidden = true;
      return;
    }
    if (!this.#wasHidden) return;
    this.#wasHidden = false;
    this.#requestResume();
  }

  #requestResume() {
    this.#resumePending = true;
    if (this.#resumeTask) return;
    this.#resumeTask = this.#drainResumeRequests().finally(() => {
      this.#resumeTask = null;
      if (this.#resumePending && !this.#disposed) this.#requestResume();
    });
  }

  async #drainResumeRequests() {
    while (this.#resumePending && !this.#disposed) {
      this.#resumePending = false;
      try {
        await this.#reconnect();
      } catch (error) {
        this.#onError(error);
      }
    }
  }
}
