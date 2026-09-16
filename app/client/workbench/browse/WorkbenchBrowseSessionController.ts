/*
 * Exports:
 * - WorkbenchBrowseSessionSnapshot: project-qualified session loading and failure projection.
 * - WorkbenchBrowseSessionControllerOptions: Browse transport and repeat scheduler ports.
 * - default WorkbenchBrowseSessionController: own Browse session reads, cancellation, mutations, polling, and disposal.
 */

import type { WorkbenchBrowseSessionSummary } from "workbench-shared/types";

export interface WorkbenchBrowseSessionSnapshot {
  error: string;
  isLoading: boolean;
  projectId: string;
  sessions: readonly WorkbenchBrowseSessionSummary[];
}

export interface WorkbenchBrowseSessionControllerOptions {
  mutate: (
    action: "forget" | "stop",
    input: { force: boolean; projectId: string; session: string },
  ) => Promise<{ result?: { error?: string | null; ok: boolean } | null }>;
  read: (projectId: string) => Promise<readonly WorkbenchBrowseSessionSummary[]>;
  scheduleRepeat?: (callback: () => void, intervalMs: number) => () => void;
}

const REFRESH_INTERVAL_MS = 30_000;

function defaultScheduleRepeat(callback: () => void, intervalMs: number) {
  const timer = window.setInterval(callback, intervalMs);
  return () => window.clearInterval(timer);
}

export default class WorkbenchBrowseSessionController {
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private refresh: Promise<void> | null = null;
  private readonly scheduleRepeat: NonNullable<WorkbenchBrowseSessionControllerOptions["scheduleRepeat"]>;
  private snapshot: WorkbenchBrowseSessionSnapshot = {
    error: "",
    isLoading: false,
    projectId: "",
    sessions: [],
  };
  private stopRepeat: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly options: WorkbenchBrowseSessionControllerOptions) {
    this.scheduleRepeat = options.scheduleRepeat ?? defaultScheduleRepeat;
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  selectProject(projectId: string) {
    if (this.snapshot.projectId === projectId) return;
    this.generation += 1;
    this.refresh = null;
    this.stopRepeat?.();
    this.stopRepeat = null;
    this.publish({
      error: "",
      isLoading: Boolean(projectId),
      projectId,
      sessions: [],
    });
    if (!projectId || this.disposed) return;
    void this.refreshSessions();
    this.stopRepeat = this.scheduleRepeat(() => {
      void this.refreshSessions();
    }, REFRESH_INTERVAL_MS);
  }

  async refreshSessions() {
    if (this.refresh) return await this.refresh;
    const { projectId } = this.snapshot;
    if (!projectId || this.disposed) return;
    const generation = this.generation;
    this.publish({ ...this.snapshot, error: "", isLoading: true });
    let task: Promise<void>;
    task = this.options.read(projectId)
      .then((sessions) => {
        if (!this.isCurrent(projectId, generation)) return;
        this.publish({ ...this.snapshot, sessions: [...sessions] });
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(projectId, generation)) return;
        this.publish({
          ...this.snapshot,
          error: error instanceof Error ? error.message : "Unable to load Browse sessions.",
        });
      })
      .finally(() => {
        if (this.refresh === task) this.refresh = null;
        if (this.isCurrent(projectId, generation)) {
          this.publish({ ...this.snapshot, isLoading: false });
        }
      });
    this.refresh = task;
    await task;
  }

  async update(
    session: WorkbenchBrowseSessionSummary,
    action: "forget" | "stop",
    { force = false }: { force?: boolean } = {},
  ) {
    const { projectId } = this.snapshot;
    if (!projectId || this.disposed) return;
    const generation = this.generation;
    try {
      const payload = await this.options.mutate(action, {
        force,
        projectId,
        session: session.name,
      });
      if (!this.isCurrent(projectId, generation)) return;
      if (payload.result?.ok === false) {
        this.publish({
          ...this.snapshot,
          error: payload.result.error ?? "Unable to stop Browse session.",
        });
        return;
      }
    } catch (error) {
      if (!this.isCurrent(projectId, generation)) return;
      this.publish({
        ...this.snapshot,
        error: error instanceof Error ? error.message : "Unable to update Browse session.",
      });
      return;
    }
    await this.refreshSessions();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.refresh = null;
    this.stopRepeat?.();
    this.stopRepeat = null;
    this.listeners.clear();
  }

  private isCurrent(projectId: string, generation: number) {
    return !this.disposed
      && this.snapshot.projectId === projectId
      && this.generation === generation;
  }

  private publish(snapshot: WorkbenchBrowseSessionSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
