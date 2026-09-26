/*
 * Exports:
 * - WorkbenchProjectFileIndexSnapshot: stable owner-scoped file candidates, paths, and read state.
 * - default WorkbenchProjectFileIndexStore: deduplicate per-location reads and fence late results.
 */
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchProjectFileIndexResponse } from "workbench-shared/workbench/project/project-file-index";
import type { ProjectTreeFileCandidate } from "workbench-shared/workbench/project/ProjectTreeFileIndex";

export interface WorkbenchProjectFileIndexSnapshot {
  candidates: readonly ProjectTreeFileCandidate[];
  paths: readonly string[];
  id: string;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
}

const EMPTY: WorkbenchProjectFileIndexSnapshot = {
  candidates: [], paths: [], id: "project-files:unavailable", status: "idle", error: null,
};

interface Entry {
  snapshot: WorkbenchProjectFileIndexSnapshot;
  listeners: Set<() => void>;
  pending: Promise<WorkbenchProjectFileIndexSnapshot> | null;
}

export default class WorkbenchProjectFileIndexStore {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(private readonly read: (target: ProjectLocationReference) => Promise<WorkbenchProjectFileIndexResponse>) {}

  private key(target: ProjectLocationReference) {
    return `${target.daemonId}/${target.projectId}`;
  }

  private entry(target: ProjectLocationReference) {
    const key = this.key(target);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { snapshot: EMPTY, listeners: new Set(), pending: null };
      this.entries.set(key, entry);
    }
    return entry;
  }

  getSnapshot(target: ProjectLocationReference | null) {
    return target && !this.disposed ? this.entry(target).snapshot : EMPTY;
  }

  subscribe(target: ProjectLocationReference | null, listener: () => void) {
    if (!target || this.disposed) return () => undefined;
    const entry = this.entry(target);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }

  async ensure(target: ProjectLocationReference, refresh = false): Promise<WorkbenchProjectFileIndexSnapshot> {
    if (this.disposed) throw new Error("Project file index has closed.");
    const entry = this.entry(target);
    if (entry.pending) return await entry.pending;
    if (!refresh && entry.snapshot.status === "ready") return entry.snapshot;
    const publish = (snapshot: WorkbenchProjectFileIndexSnapshot) => {
      entry.snapshot = snapshot;
      for (const listener of entry.listeners) listener();
    };
    publish({ ...entry.snapshot, status: "loading", error: null });
    const pending = (async () => {
      try {
        const result = await this.read(target);
        if (this.disposed) return entry.snapshot;
        if (result.projectId !== target.projectId) throw new Error("The daemon returned another project's file index.");
        const candidates = result.candidates;
        publish({
          candidates,
          paths: candidates.map(item => item.path),
          id: `${this.key(target)}:${result.key}`,
          status: "ready",
          error: null,
        });
      } catch (error) {
        if (this.disposed) return entry.snapshot;
        const message = (error instanceof Error ? error.message : "Project files could not be read.")
          .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 512);
        console.error("Project file suggestions unavailable:", message);
        publish({ ...entry.snapshot, status: "error", error: message });
      }
      return entry.snapshot;
    })();
    entry.pending = pending;
    try {
      return await pending;
    } finally {
      if (entry.pending === pending) entry.pending = null;
    }
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.listeners.clear();
    this.entries.clear();
  }
}
