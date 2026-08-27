/*
 * WorkbenchTranscriptSubscriptionController: owns active latest-window reads, serialized refresh, replacement, and disposal. Keywords: transcript, subscription, lifecycle.
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
  refresh: Promise<void>;
}

export default class WorkbenchTranscriptSubscriptionController {
  readonly #read: (request: WorkbenchTranscriptReadRequest) => Promise<WorkbenchTranscriptSnapshot | null>;
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  #disposed = false;

  constructor(read: (request: WorkbenchTranscriptReadRequest) => Promise<WorkbenchTranscriptSnapshot | null>) {
    this.#read = read;
  }

  async subscribe(subscription: WorkbenchTranscriptSubscription) {
    if (this.#disposed) throw new Error("Workbench transcript subscriptions are disposed");
    if (subscription.request.beforeTurnIndex !== undefined) {
      throw new Error("Only the active latest transcript window can subscribe");
    }
    this.unsubscribe(subscription.id);
    const active: ActiveSubscription = { ...subscription, refresh: Promise.resolve() };
    this.#subscriptions.set(subscription.id, active);
    await this.#refresh(active);
  }

  unsubscribe(id: string) {
    this.#subscriptions.delete(id);
  }

  async settle(changedThreadIds: readonly string[]) {
    if (this.#disposed || changedThreadIds.length === 0) return;
    const changed = new Set(changedThreadIds);
    await Promise.all(
      [...this.#subscriptions.values()]
        .filter(({ request }) => changed.has(request.threadId))
        .map((subscription) => this.#refresh(subscription)),
    );
  }

  dispose() {
    this.#disposed = true;
    this.#subscriptions.clear();
  }

  #refresh(subscription: ActiveSubscription) {
    subscription.refresh = subscription.refresh.then(async () => {
      if (this.#disposed || this.#subscriptions.get(subscription.id) !== subscription) return;
      const snapshot = await this.#read(subscription.request);
      if (this.#disposed || this.#subscriptions.get(subscription.id) !== subscription) return;
      await subscription.publish(snapshot);
    });
    return subscription.refresh;
  }
}
