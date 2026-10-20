/*
 * Exports:
 * - WorkbenchNavigationSnapshot: active route, generation and failure.
 * - WorkbenchNavigationPorts: cancellable view application without connection orchestration.
 * - default WorkbenchNavigationController: own route intent and supersession.
 */

import type { WorkbenchRouteLoadResult } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  isSameWorkbenchRoute,
  type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";

export interface WorkbenchNavigationSnapshot {
  error: string | null;
  generation: number;
  phase: "idle" | "loading" | "ready" | "failed";
  route: WorkbenchRoute;
}

export interface WorkbenchNavigationPorts {
  load(route: WorkbenchRoute, context: { isCurrent(): boolean; signal: AbortSignal }): Promise<WorkbenchRouteLoadResult>;
}

export default class WorkbenchNavigationController {
  private readonly listeners = new Set<() => void>();
  private snapshot: WorkbenchNavigationSnapshot;
  private operation: AbortController | null = null;
  private disposed = false;

  constructor(initialRoute: WorkbenchRoute, private readonly ports: WorkbenchNavigationPorts) {
    this.snapshot = {
      error: null,
      generation: 0,
      phase: "idle",
      route: initialRoute,
    };
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  isCurrent(route: WorkbenchRoute, generation: number) {
    const active = this.snapshot;
    return !this.disposed && active.generation === generation
      && active.route.view === route.view
      && active.route.projectId === route.projectId
      && active.route.filePath === route.filePath
      && active.route.threadId === route.threadId
      && active.route.threadOwnerProjectId === route.threadOwnerProjectId
      && isSameWorkbenchRoute(active.route, route);
  }

  rejectRoute(route: WorkbenchRoute, error: string): WorkbenchRouteLoadResult {
    this.operation?.abort(new Error("Navigation rejected."));
    this.publish({
      ...this.snapshot, error, generation: this.snapshot.generation + 1,
      phase: "failed", route,
    });
    return { ok: false, error };
  }

  async applyRoute(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult> {
    if (this.disposed) return { ok: false };
    this.operation?.abort(new Error("Navigation superseded."));
    const operation = new AbortController();
    this.operation = operation;
    let result: WorkbenchRouteLoadResult = { ok: false };
    const generation = this.snapshot.generation + 1;
    this.publish({
      ...this.snapshot, error: null, generation, phase: "loading", route,
    });
    try {
      result = await this.ports.load(route, {
        isCurrent: () => this.isCurrent(route, generation) && !operation.signal.aborted,
        signal: operation.signal,
      });
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message.slice(0, 512)
        : "The view could not open." };
    }
    if (this.snapshot.generation === generation) {
      this.publish({
        ...this.snapshot, phase: result.pending ? "loading" : result.ok ? "ready" : "failed",
        error: result.pending || result.ok ? null : result.error ?? "The view could not open.",
      });
    }
    return result;
  }

  dispose() {
    this.disposed = true;
    this.operation?.abort(new Error("Navigation disposed."));
    this.listeners.clear();
  }

  private publish(snapshot: WorkbenchNavigationSnapshot) {
    if (this.disposed || areDeeplyEqual(this.snapshot, snapshot)) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
