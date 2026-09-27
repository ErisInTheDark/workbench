/*
 * Exports:
 * - default WorkbenchRouteIntentController: retain one URL intent across source availability and supersession.
 */
import type { WorkbenchRouteLoadResult } from "workbench-shared/types";
import { isSameWorkbenchRoute, type WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";

export default class WorkbenchRouteIntentController {
  private intent: WorkbenchRoute | null = null;
  private generation = 0;
  private sourceRevision = 0;
  private outcome: "idle" | "ready" | "failed" = "idle";
  private attempt: { generation: number } | null = null;
  private disposed = false;
  private readonly canonicalListeners = new Set<(route: WorkbenchRoute) => void>();

  constructor(private readonly options: {
    available(): boolean;
    apply(route: WorkbenchRoute): Promise<WorkbenchRouteLoadResult>;
    onError?(error: unknown): void;
  }) {}

  subscribeCanonical(listener: (route: WorkbenchRoute) => void) {
    this.canonicalListeners.add(listener);
    return () => { this.canonicalListeners.delete(listener); };
  }

  request(route: WorkbenchRoute) {
    if (this.disposed) return;
    if (this.intent && isSameWorkbenchRoute(this.intent, route)
      && (this.outcome === "ready" || this.attempt?.generation === this.generation)) return;
    this.intent = route;
    this.generation++;
    this.outcome = "idle";
    this.run();
  }

  supersede(route: WorkbenchRoute) {
    if (!this.intent || isSameWorkbenchRoute(this.intent, route)) return;
    this.intent = null;
    this.generation++;
    this.attempt = null;
    this.outcome = "idle";
  }

  sourceAvailable() {
    if (this.disposed) return;
    this.sourceRevision++;
    if (this.outcome === "failed" || this.outcome === "idle") this.run();
  }

  private run() {
    const route = this.intent;
    if (this.disposed || !route || !this.options.available()
      || this.outcome === "ready" || this.attempt?.generation === this.generation) return;
    const generation = this.generation;
    const sourceRevision = this.sourceRevision;
    this.attempt = { generation };
    void this.options.apply(route).then(result => {
      if (this.disposed || generation !== this.generation) return;
      this.attempt = null;
      this.outcome = result.ok ? "ready" : "failed";
      if (result.ok && result.canonicalRoute) {
        for (const listener of this.canonicalListeners) listener(result.canonicalRoute);
      }
      if (!result.ok && this.sourceRevision !== sourceRevision) this.run();
    }, error => {
      if (this.disposed || generation !== this.generation) return;
      this.attempt = null;
      this.outcome = "failed";
      this.options.onError?.(error);
      if (this.sourceRevision !== sourceRevision) this.run();
    });
  }

  dispose() {
    this.disposed = true;
    this.intent = null;
    this.canonicalListeners.clear();
  }
}
