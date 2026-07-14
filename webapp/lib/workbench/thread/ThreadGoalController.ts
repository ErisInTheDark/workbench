/*
 * Exports:
 * - default ThreadGoalController: own typed Codex goal reads, objective updates, clears, notifications, and React-facing snapshots. Keywords: thread, goal, controller, codex.
 */

import type { CodexAppServerNotification } from "../../codex/app-server-notifications";
import type { ThreadGoalClearParams } from "../../codex/generated/app-server/v2/ThreadGoalClearParams";
import type { ThreadGoalClearResponse } from "../../codex/generated/app-server/v2/ThreadGoalClearResponse";
import type { ThreadGoalGetParams } from "../../codex/generated/app-server/v2/ThreadGoalGetParams";
import type { ThreadGoalGetResponse } from "../../codex/generated/app-server/v2/ThreadGoalGetResponse";
import type { ThreadGoalSetParams } from "../../codex/generated/app-server/v2/ThreadGoalSetParams";
import type { ThreadGoalSetResponse } from "../../codex/generated/app-server/v2/ThreadGoalSetResponse";
import type { WorkbenchThreadGoalControls, WorkbenchThreadGoalSnapshot } from "../../types";

type ThreadGoalNotification = Extract<CodexAppServerNotification, {
  method: "thread/goal/cleared" | "thread/goal/updated";
}>;

interface ThreadGoalTransport {
  clear: (params: ThreadGoalClearParams) => Promise<ThreadGoalClearResponse>;
  get: (params: ThreadGoalGetParams) => Promise<ThreadGoalGetResponse>;
  set: (params: ThreadGoalSetParams) => Promise<ThreadGoalSetResponse>;
}

interface ThreadGoalEntry {
  generation: number;
  loadPromise: Promise<void> | null;
  operation: number;
  snapshot: WorkbenchThreadGoalSnapshot;
}

function createSnapshot(): WorkbenchThreadGoalSnapshot {
  return {
    error: null,
    goal: null,
    isLoaded: false,
    isLoading: false,
    pendingAction: null,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unable to update the thread goal.";
}

export default class ThreadGoalController implements WorkbenchThreadGoalControls {
  private disposed = false;
  private readonly entries = new Map<string, ThreadGoalEntry>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly transport: ThreadGoalTransport) {}

  clear = async (threadId: string) => {
    const entry = this.beginMutation(threadId, "clear");
    const generation = entry.generation;
    const operation = entry.operation;
    try {
      await this.transport.clear({ threadId });
      if (!this.isCurrentOperation(entry, operation)) return;
      if (entry.generation !== generation) {
        this.commit(threadId, entry, { ...entry.snapshot, pendingAction: null });
        return;
      }
      entry.generation += 1;
      this.commit(threadId, entry, {
        error: null,
        goal: null,
        isLoaded: true,
        isLoading: false,
        pendingAction: null,
      });
    } catch (error) {
      if (!this.isCurrentOperation(entry, operation)) return;
      this.commit(threadId, entry, {
        ...entry.snapshot,
        error: errorMessage(error),
        pendingAction: null,
      });
      throw error;
    }
  };

  dispose() {
    this.disposed = true;
    this.entries.clear();
    this.listeners.clear();
  }

  getSnapshot = (threadId: string) => this.getEntry(threadId).snapshot;

  load = (threadId: string) => this.read(threadId, false);

  observeNotification(notification: ThreadGoalNotification) {
    if (this.disposed) return;
    const threadId = notification.params.threadId;
    const entry = this.getEntry(threadId);
    entry.generation += 1;
    this.commit(threadId, entry, {
      error: null,
      goal: notification.method === "thread/goal/updated" ? notification.params.goal : null,
      isLoaded: true,
      isLoading: false,
      pendingAction: entry.snapshot.pendingAction,
    });
  }

  refresh = (threadId: string) => this.read(threadId, true);

  subscribe = (threadId: string, listener: () => void) => {
    const listeners = this.listeners.get(threadId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(threadId);
    };
  };

  updateObjective = async (threadId: string, objective: string) => {
    const entry = this.getEntry(threadId);
    if (!entry.snapshot.goal) {
      throw new Error("This thread no longer has a goal to edit.");
    }

    const mutationEntry = this.beginMutation(threadId, "update");
    const generation = mutationEntry.generation;
    const operation = mutationEntry.operation;
    try {
      const response = await this.transport.set({ objective, threadId });
      if (!this.isCurrentOperation(mutationEntry, operation)) return;
      if (mutationEntry.generation !== generation) {
        this.commit(threadId, mutationEntry, { ...mutationEntry.snapshot, pendingAction: null });
        return;
      }
      mutationEntry.generation += 1;
      this.commit(threadId, mutationEntry, {
        error: null,
        goal: response.goal,
        isLoaded: true,
        isLoading: false,
        pendingAction: null,
      });
    } catch (error) {
      if (!this.isCurrentOperation(mutationEntry, operation)) return;
      this.commit(threadId, mutationEntry, {
        ...mutationEntry.snapshot,
        error: errorMessage(error),
        pendingAction: null,
      });
      throw error;
    }
  };

  private beginMutation(threadId: string, pendingAction: NonNullable<WorkbenchThreadGoalSnapshot["pendingAction"]>) {
    const entry = this.getEntry(threadId);
    entry.generation += 1;
    entry.operation += 1;
    this.commit(threadId, entry, {
      ...entry.snapshot,
      error: null,
      isLoading: false,
      pendingAction,
    });
    return entry;
  }

  private commit(threadId: string, entry: ThreadGoalEntry, snapshot: WorkbenchThreadGoalSnapshot) {
    if (this.disposed) return;
    entry.snapshot = snapshot;
    this.listeners.get(threadId)?.forEach((listener) => listener());
  }

  private getEntry(threadId: string) {
    const existing = this.entries.get(threadId);
    if (existing) return existing;
    const entry: ThreadGoalEntry = {
      generation: 0,
      loadPromise: null,
      operation: 0,
      snapshot: createSnapshot(),
    };
    this.entries.set(threadId, entry);
    return entry;
  }

  private isCurrentOperation(entry: ThreadGoalEntry, operation: number) {
    return !this.disposed && entry.operation === operation;
  }

  private read(threadId: string, force: boolean) {
    const entry = this.getEntry(threadId);
    if (entry.loadPromise) return entry.loadPromise;
    if (!force && entry.snapshot.isLoaded) return Promise.resolve();

    const generation = ++entry.generation;
    this.commit(threadId, entry, {
      ...entry.snapshot,
      error: null,
      isLoading: true,
    });
    const loadPromise = this.transport.get({ threadId }).then((response) => {
      if (this.disposed || entry.generation !== generation) return;
      this.commit(threadId, entry, {
        error: null,
        goal: response.goal,
        isLoaded: true,
        isLoading: false,
        pendingAction: entry.snapshot.pendingAction,
      });
    }).catch((error) => {
      if (this.disposed || entry.generation !== generation) return;
      this.commit(threadId, entry, {
        ...entry.snapshot,
        error: errorMessage(error),
        isLoaded: true,
        isLoading: false,
      });
    }).finally(() => {
      if (entry.loadPromise === loadPromise) entry.loadPromise = null;
    });
    entry.loadPromise = loadPromise;
    return loadPromise;
  }
}
