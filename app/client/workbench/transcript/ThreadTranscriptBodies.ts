/*
 * Exports:
 * - ThreadTranscriptBodyState: one deferred tool item's hydration state.
 * - ThreadTranscriptBodyReader: reads complete rows for delivered items of the current subscription.
 * - default ThreadTranscriptBodies: keyed, batched, retryable hydration of deferred tool bodies for one thread transcript.
 */
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
import {
  projectWorkbenchTranscript,
  type WorkbenchProjectedTranscriptItem,
} from "workbench-shared/workbench/transcript/workbench-transcript-projection";

export type ThreadTranscriptBodyState =
  | { status: "idle" | "loading" }
  | { status: "loaded"; item: WorkbenchProjectedTranscriptItem }
  | { status: "failed"; message: string };

export type ThreadTranscriptBodyReader = (itemIds: string[]) => Promise<WorkbenchTranscriptSnapshot>;

const IDLE: ThreadTranscriptBodyState = { status: "idle" };
const LOADING: ThreadTranscriptBodyState = { status: "loading" };
/** Matches the app's per-request item bound. */
const MAX_BATCH = 64;

export default class ThreadTranscriptBodies {
  readonly #states = new Map<string, ThreadTranscriptBodyState>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #queued = new Set<string>();
  #read: ThreadTranscriptBodyReader | null = null;
  #generation = 0;
  #flushScheduled = false;

  /** A new subscription owns new bodies; cached and in-flight bodies of the previous one are discarded. */
  bind(read: ThreadTranscriptBodyReader | null) {
    if (this.#read === read) return;
    this.#read = read;
    this.#generation += 1;
    this.#queued.clear();
    const ids = [...this.#states.keys()];
    this.#states.clear();
    for (const id of ids) this.#notify(id);
  }

  get(itemId: string): ThreadTranscriptBodyState {
    return this.#states.get(itemId) ?? IDLE;
  }

  subscribe(itemId: string, listener: () => void) {
    let listeners = this.#listeners.get(itemId);
    if (!listeners) this.#listeners.set(itemId, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(itemId);
    };
  }

  /** Loads once; repeated or concurrent demands share the same request. */
  load(itemId: string) {
    const status = this.get(itemId).status;
    if (status === "loading" || status === "loaded") return;
    this.#set(itemId, LOADING);
    this.#queued.add(itemId);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  retry(itemId: string) {
    if (this.get(itemId).status !== "failed") return;
    this.#states.delete(itemId);
    this.load(itemId);
  }

  #flush() {
    const generation = this.#generation;
    const read = this.#read;
    const ids = [...this.#queued];
    this.#queued.clear();
    for (let index = 0; index < ids.length; index += MAX_BATCH) {
      const batch = ids.slice(index, index + MAX_BATCH);
      if (!read) {
        for (const id of batch) this.#set(id, { status: "failed", message: "The transcript is not connected." });
        continue;
      }
      void read(batch).then(snapshot => {
        if (generation !== this.#generation) return;
        const projected = projectWorkbenchTranscript(snapshot);
        if (!projected.success) throw new Error("Tool output rows could not be projected.");
        const items = new Map(projected.data.turns.flatMap(turn => turn.items.map(item => [item.id, item] as const)));
        for (const id of batch) {
          const item = items.get(id);
          this.#set(id, item ? { status: "loaded", item } : { status: "failed", message: "Tool output is missing." });
        }
      }).catch((error: unknown) => {
        if (generation !== this.#generation) return;
        const message = (error instanceof Error ? error.message : "Tool output could not load.").slice(0, 300);
        console.error("Deferred tool output failed to load.", message);
        for (const id of batch) this.#set(id, { status: "failed", message });
      });
    }
  }

  #set(itemId: string, state: ThreadTranscriptBodyState) {
    this.#states.set(itemId, state);
    this.#notify(itemId);
  }

  #notify(itemId: string) {
    for (const listener of this.#listeners.get(itemId) ?? []) listener();
  }
}
