/*
 * Exports:
 * - WorkbenchTranscriptSubscription: snapshot or incremental latest-window subscription.
 * - default WorkbenchTranscriptSubscriptionController: own bootstrap, replacement and disposal.
 */
import type {
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSnapshot,
} from "./workbench-transcript-types.ts";
import type { TranscriptStreamUpdate } from "workbench-shared/workbench/transcript/thread-transcript-stream";
import type WorkbenchTranscriptLiveController from "./WorkbenchTranscriptLiveController";

export interface WorkbenchTranscriptSubscription {
  id: string;
  request: WorkbenchTranscriptReadRequest;
  publish: (snapshot: WorkbenchTranscriptSnapshot | null) => void | Promise<void>;
  publishStream?: (update: TranscriptStreamUpdate) => void;
}

interface ActiveSubscription extends WorkbenchTranscriptSubscription {
  dirty: boolean;
  refreshing: boolean;
}

export default class WorkbenchTranscriptSubscriptionController {
  readonly #read: (request: WorkbenchTranscriptReadRequest) => Promise<WorkbenchTranscriptSnapshot | null>;
  readonly #reportFailure: (error: unknown) => void;
  readonly #subscriptions = new Map<string, ActiveSubscription>();
  readonly #live?: WorkbenchTranscriptLiveController;
  #disposed = false;

  constructor(
    read: (request: WorkbenchTranscriptReadRequest) => Promise<WorkbenchTranscriptSnapshot | null>,
    reportFailure: (error: unknown) => void,
    live?: WorkbenchTranscriptLiveController,
  ) {
    this.#read = read;
    this.#reportFailure = reportFailure;
    this.#live = live;
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
      if (this.#subscriptions.get(active.id) === active) this.unsubscribe(active.id);
      throw error;
    } finally {
      active.refreshing = false;
    }
    if (active.dirty) this.#startRefresh(active);
  }

  unsubscribe(id: string) {
    this.#subscriptions.delete(id);
    this.#live?.close(id);
  }

  settle(changedThreadIds: readonly string[], { snapshots = true } = {}) {
    if (this.#disposed || changedThreadIds.length === 0) return;
    const changed = new Set(changedThreadIds);
    for (const subscription of this.#subscriptions.values()) {
      // Live views, including ones still reading their baseline, receive settlements without a reread.
      if (subscription.publishStream ? this.#live?.tracks(subscription.id) : !snapshots) continue;
      if (!changed.has(subscription.request.threadId)) continue;
      subscription.dirty = true;
      this.#startRefresh(subscription);
    }
  }

  dispose() {
    this.#disposed = true;
    this.#subscriptions.clear();
    this.#live?.dispose();
  }

  async #readAndPublish(subscription: ActiveSubscription) {
    if (this.#disposed || this.#subscriptions.get(subscription.id) !== subscription) return;
    if (subscription.publishStream && this.#live) {
      // Buffer settlements before reading, so the read never waits on (or blocks) provider ingest.
      this.#live.beginOpen(subscription.id, subscription.request.threadId);
      let snapshot: WorkbenchTranscriptSnapshot | null;
      try {
        snapshot = await this.#read(subscription.request);
      } catch (error) {
        if (!this.#disposed && this.#subscriptions.get(subscription.id) === subscription) this.#live.close(subscription.id);
        throw error;
      }
      if (this.#disposed || this.#subscriptions.get(subscription.id) !== subscription) return;
      if (this.#live.open(subscription.id, snapshot, subscription.publishStream)) subscription.dirty = true;
      return;
    }
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
