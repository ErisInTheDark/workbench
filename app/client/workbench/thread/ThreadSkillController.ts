/*
 * Exports:
 * - default ThreadSkillController: own per-thread active-skill reads, deactivation, notifications and display snapshots.
 */

import type { WorkbenchTranscriptNotification } from "workbench-shared/workbench/provider/provider-observation";
import type { WorkbenchThreadSkill } from "workbench-shared/workbench/thread/thread-skill-state";
import type { WorkbenchThreadSkillControls, WorkbenchThreadSkillSnapshot } from "workbench-shared/types";

type ThreadSkillNotification = Extract<WorkbenchTranscriptNotification, { method: "thread/skills/updated" }>;

interface ThreadSkillTransport {
  read: (params: { threadId: string }) => Promise<{ skills: WorkbenchThreadSkill[] }>;
  deactivate: (params: { threadId: string; path: string }) => Promise<{ skills: WorkbenchThreadSkill[] }>;
}

interface ThreadSkillEntry {
  /** Bumped by every authoritative skill list, so an older read never overwrites a newer one. */
  generation: number;
  loadPromise: Promise<void> | null;
  snapshot: WorkbenchThreadSkillSnapshot;
}

const EMPTY_SNAPSHOT: WorkbenchThreadSkillSnapshot = { error: null, isLoaded: false, pendingPaths: [], skills: [] };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unable to update the thread skills.";
}

export default class ThreadSkillController implements WorkbenchThreadSkillControls {
  private disposed = false;
  private readonly entries = new Map<string, ThreadSkillEntry>();
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly transport: ThreadSkillTransport) {}

  deactivate = async (threadId: string, path: string) => {
    const entry = this.getEntry(threadId);
    if (entry.snapshot.pendingPaths.includes(path)) return;
    this.commit(threadId, entry, { ...entry.snapshot, error: null, pendingPaths: [...entry.snapshot.pendingPaths, path] });
    const release = () => entry.snapshot.pendingPaths.filter(candidate => candidate !== path);
    try {
      const { skills } = await this.transport.deactivate({ threadId, path });
      this.accept(threadId, skills, { pendingPaths: release() });
    } catch (error) {
      this.commit(threadId, entry, { ...entry.snapshot, error: errorMessage(error), pendingPaths: release() });
    }
  };

  dispose() {
    this.disposed = true;
    this.entries.clear();
    this.listeners.clear();
  }

  getSnapshot = (threadId: string) => this.entries.get(threadId)?.snapshot ?? EMPTY_SNAPSHOT;

  load = (threadId: string) => {
    const entry = this.getEntry(threadId);
    if (entry.loadPromise) return entry.loadPromise;
    if (entry.snapshot.isLoaded) return Promise.resolve();
    const generation = entry.generation;
    const loadPromise = this.transport.read({ threadId }).then(({ skills }) => {
      if (entry.generation === generation) this.accept(threadId, skills);
    }, (error: unknown) => {
      if (entry.generation === generation) this.commit(threadId, entry, { ...entry.snapshot, error: errorMessage(error), isLoaded: true });
    }).finally(() => {
      if (entry.loadPromise === loadPromise) entry.loadPromise = null;
    });
    entry.loadPromise = loadPromise;
    return loadPromise;
  };

  observeNotification(notification: ThreadSkillNotification) {
    this.accept(notification.params.threadId, notification.params.skills);
  }

  subscribe = (threadId: string, listener: () => void) => {
    const listeners = this.listeners.get(threadId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(threadId);
    };
  };

  private accept(threadId: string, skills: readonly WorkbenchThreadSkill[], overrides: Partial<WorkbenchThreadSkillSnapshot> = {}) {
    if (this.disposed) return;
    const entry = this.getEntry(threadId);
    entry.generation += 1;
    this.commit(threadId, entry, { ...entry.snapshot, error: null, isLoaded: true, skills: [...skills], ...overrides });
  }

  private commit(threadId: string, entry: ThreadSkillEntry, snapshot: WorkbenchThreadSkillSnapshot) {
    if (this.disposed) return;
    entry.snapshot = snapshot;
    this.listeners.get(threadId)?.forEach(listener => listener());
  }

  private getEntry(threadId: string) {
    const existing = this.entries.get(threadId);
    if (existing) return existing;
    const entry: ThreadSkillEntry = { generation: 0, loadPromise: null, snapshot: EMPTY_SNAPSHOT };
    this.entries.set(threadId, entry);
    return entry;
  }
}
