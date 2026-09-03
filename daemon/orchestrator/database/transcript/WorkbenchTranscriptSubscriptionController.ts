/*
 * WorkbenchTranscriptSubscriptionController: owns active latest-window reads, coalesced refresh, replacement, and disposal. Keywords: transcript, subscription, lifecycle.
 */
import type {
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSnapshot,
} from "./workbench-transcript-types.ts";

export interface WorkbenchTranscriptSubscription {
  id: string;
  request: WorkbenchTranscriptReadRequest;
  publish: (snapshot: WorkbenchTranscriptSnapshot | null) => void | Promise<void>;
}

interface ActiveSubscription extends WorkbenchTranscriptSubscription {
  dirty: boolean;
  refreshing: boolean;
}

export default class WorkbenchTranscriptSubscriptionController {
  readonly #read: (request: WorkbenchTranscriptReadRequest) => Promise<WorkbenchTranscriptSnapshot | null>;
  readonly #reportFailure: (error: unknown) => void;
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  #disposed = false;

  constructor(
    read: (request: WorkbenchTranscriptReadRequest) => Promise<WorkbenchTranscriptSnapshot | null>,
    reportFailure: (error: unknown) => void,
  ) {
    this.#read = read;
    this.#reportFailure = reportFailure;
  }

  async subscribe(subscription: WorkbenchTranscriptSubscription) {
    if (this.#disposed) throw new Error("Workbench transcript subscriptions are disposed");
    if (subscription.request.beforeTurnIndex !== undefined) {
      throw new Error("Only the active latest transcript window can subscribe");
    }
    this.unsubscribe(subscription.id);
    const active: ActiveSubscription = { ...subscription, dirty: false, refreshing: true };
    this.#subscriptions.set(subscription.id, active);
    try {
      await this.#readAndPublish(active);
    } catch (error) {
      if (this.#subscriptions.get(active.id) === active) this.#subscriptions.delete(active.id);
      throw error;
    } finally {
      active.refreshing = false;
    }
    if (active.dirty) this.#startRefresh(active);
  }

  unsubscribe(id: string) {
    this.#subscriptions.delete(id);
  }

  settle(changedThreadIds: readonly string[]) {
    if (this.#disposed || changedThreadIds.length === 0) return;
    const changed = new Set(changedThreadIds);
    for (const subscription of this.#subscriptions.values()) {
      if (!changed.has(subscription.request.threadId)) continue;
      subscription.dirty = true;
      this.#startRefresh(subscription);
    }
  }

  dispose() {
    this.#disposed = true;
    this.#subscriptions.clear();
  }

  async #readAndPublish(subscription: ActiveSubscription) {
    if (this.#disposed || this.#subscriptions.get(subscription.id) !== subscription) return;
    const snapshot = await this.#read(subscription.request);
    if (this.#disposed || this.#subscriptions.get(subscription.id) !== subscription) return;
    await subscription.publish(snapshot);
  }

  async #refresh(subscription: ActiveSubscription) {
    let failed = false;
    try {
      while (
        !this.#disposed
        && this.#subscriptions.get(subscription.id) === subscription
        && subscription.dirty
      ) {
        subscription.dirty = false;
        try {
          await this.#readAndPublish(subscription);
        } catch (error) {
          failed = true;
          this.#reportFailure(error);
          return;
        }
      }
    } finally {
      subscription.refreshing = false;
      if (!failed && subscription.dirty) this.#startRefresh(subscription);
    }
  }

  #startRefresh(subscription: ActiveSubscription) {
    if (
      subscription.refreshing
      || this.#disposed
      || this.#subscriptions.get(subscription.id) !== subscription
    ) {
      return;
    }
    subscription.refreshing = true;
    void this.#refresh(subscription);
  }
}
