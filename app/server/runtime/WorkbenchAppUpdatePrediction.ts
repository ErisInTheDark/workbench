/*
 * Exports:
 * - default WorkbenchAppUpdatePrediction: own the app's prediction of the client scopes the attached daemon's pending
 *   update would dirty, recomputed only when the update's incoming change set moves.
 */
import type { ReloadDirtScope as WorkbenchReloadDirtScope } from "workbench-shared/reload/reload-dirt-scope";
import type { PredictedInstallationUpdate as InstallationUpdate } from "workbench-shared/workbench/installation-update-prediction";
import type WorkbenchDaemonSources from "../workspace/WorkbenchDaemonSources";

interface Ports {
  predict(incomingPaths: readonly string[], target: string, signal: AbortSignal): Promise<WorkbenchReloadDirtScope[]>;
  warn(message: string): void;
}

/** The change set a prediction depends on; null when there is nothing to predict. */
function predictionKey(update: InstallationUpdate | null) {
  if (!update?.upstream || !update.incomingPaths || (update.state !== "available" && update.state !== "conflict")) return null;
  return `${update.upstream}\0${update.incomingPaths.join("\0")}`;
}

export default class WorkbenchAppUpdatePrediction {
  private key: string | null = null;
  private scopes: WorkbenchReloadDirtScope[] | null = null;
  private running: AbortController | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly ports: Ports) {}

  read = () => this.scopes;

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A newer change set supersedes an unfinished prediction; an unknown one clears the last result. */
  accept(update: InstallationUpdate | null) {
    const key = predictionKey(update);
    if (key === this.key) return;
    this.key = key;
    this.running?.abort(new Error("Update prediction was superseded."));
    this.running = null;
    if (!key || !update?.upstream || !update.incomingPaths) {
      this.publish(null);
      return;
    }
    const running = new AbortController();
    this.running = running;
    void this.ports.predict(update.incomingPaths, update.upstream, running.signal).then(scopes => {
      if (this.running === running) this.publish(scopes);
    }, (error: unknown) => {
      if (this.running !== running) return;
      this.ports.warn(`Update prediction failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
      this.publish(null);
    }).finally(() => { if (this.running === running) this.running = null; });
  }

  /** Feed predictions from the attached daemon's update, rebinding when the attached daemon changes. */
  follow(sources: Pick<WorkbenchDaemonSources, "attached" | "subscribe">) {
    let bound: { id: string; release(): void } | null = null;
    const bind = () => {
      const source = sources.attached;
      if ((source?.id ?? null) === (bound?.id ?? null)) return;
      bound?.release();
      bound = null;
      if (!source) { this.accept(null); return; }
      const observation = source.observe({ kind: "update" }, () => {
        const value = observation.getSnapshot().value;
        this.accept(value?.kind === "update" ? value.data : null);
      });
      bound = { id: source.id, release: observation.release };
    };
    const unsubscribe = sources.subscribe(bind);
    bind();
    return () => { unsubscribe(); bound?.release(); bound = null; };
  }

  dispose() {
    this.running?.abort(new Error("Update prediction owner was retired."));
    this.running = null;
    this.listeners.clear();
  }

  private publish(scopes: WorkbenchReloadDirtScope[] | null) {
    this.scopes = scopes;
    for (const listener of [...this.listeners]) listener();
  }
}
