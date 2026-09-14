/*
 * Exports:
 * - WorkbenchConnectionContinuity: distinguish a live browser resume from observed transport loss. Keywords: browser, visibility, reconnect, continuity.
 * - WorkbenchConnectionRecoveryControllerOptions: recovery, failure, and visibility ports for connection recovery. Keywords: browser, recovery, lifecycle.
 * - default WorkbenchConnectionRecoveryController: serialize continuity recovery requests and own browser visibility cleanup. Keywords: browser, resume, reconnect, lifecycle.
 */

export type WorkbenchConnectionContinuity = "preserved" | "lost";

export interface WorkbenchConnectionRecoveryControllerOptions {
  onError?: (continuity: WorkbenchConnectionContinuity, error: unknown) => void;
  recover: (continuity: WorkbenchConnectionContinuity) => void | Promise<void>;
  visibility?: {
    hidden(): boolean;
    subscribe(listener: () => void): () => void;
  };
}

function browserVisibility(): NonNullable<WorkbenchConnectionRecoveryControllerOptions["visibility"]> {
  return {
    hidden: () => typeof document !== "undefined" && document.hidden,
    subscribe: (listener) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

export default class WorkbenchConnectionRecoveryController {
  readonly #onError: NonNullable<WorkbenchConnectionRecoveryControllerOptions["onError"]>;
  readonly #recover: WorkbenchConnectionRecoveryControllerOptions["recover"];
  readonly #visibility: NonNullable<WorkbenchConnectionRecoveryControllerOptions["visibility"]>;
  #activeContinuity: WorkbenchConnectionContinuity | null = null;
  #disposed = false;
  #pendingContinuity: WorkbenchConnectionContinuity | null = null;
  #recoveryTask: Promise<void> | null = null;
  #unsubscribe: (() => void) | null = null;
  #wasHidden: boolean;

  constructor({
    onError = () => undefined,
    recover,
    visibility = browserVisibility(),
  }: WorkbenchConnectionRecoveryControllerOptions) {
    this.#onError = onError;
    this.#recover = recover;
    this.#visibility = visibility;
    this.#wasHidden = visibility.hidden();
  }

  start() {
    if (this.#disposed || this.#unsubscribe) return;
    this.#wasHidden = this.#visibility.hidden();
    this.#unsubscribe = this.#visibility.subscribe(() => this.#handleVisibilityChange());
  }

  recoverAfterConnectionLoss() {
    this.#requestRecovery("lost");
  }

  dispose() {
    this.#disposed = true;
    this.#pendingContinuity = null;
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
    this.#requestRecovery("preserved");
  }

  #requestRecovery(continuity: WorkbenchConnectionContinuity) {
    if (this.#disposed) return;
    if (
      continuity === "preserved"
      && (this.#activeContinuity === "lost" || this.#pendingContinuity === "lost")
    ) {
      return;
    }
    this.#pendingContinuity = continuity;
    if (this.#recoveryTask) return;
    this.#recoveryTask = this.#drainRecoveryRequests().finally(() => {
      this.#recoveryTask = null;
      if (this.#pendingContinuity && !this.#disposed) {
        this.#requestRecovery(this.#pendingContinuity);
      }
    });
  }

  async #drainRecoveryRequests() {
    while (this.#pendingContinuity && !this.#disposed) {
      const continuity = this.#pendingContinuity;
      this.#pendingContinuity = null;
      this.#activeContinuity = continuity;
      try {
        await this.#recover(continuity);
      } catch (error) {
        this.#onError(continuity, error);
      } finally {
        this.#activeContinuity = null;
      }
    }
  }
}
