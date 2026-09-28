/*
 * Exports:
 * - WorkbenchAppRuntimeClientOptions: workspace facts, loaded bundle identity and reload handoff transport.
 * - default WorkbenchAppRuntimeClient: project pushed runtime facts and preserve connection-changing reload control.
 */
import type { WorkbenchReloadResponse, WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";

import type {
  WorkbenchAppRuntimeSnapshot,
  WorkbenchFrontendGeneration,
} from "workbench-shared/types";
import { DaemonReloadResponseSchema } from "workbench-shared/workbench/daemon-reload";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type WorkbenchWorkspaceClient from "./WorkbenchWorkspaceClient";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";

const EMPTY: WorkbenchAppRuntimeSnapshot = {
  dirtyScopes: [],
  error: null,
  pendingScopes: [],
  tabOutOfDate: false,
};

export interface WorkbenchAppRuntimeClientOptions {
  fetcher?: typeof fetch;
  loadedFrontendGeneration?: WorkbenchFrontendGeneration | null;
  workspace: WorkbenchWorkspaceClient;
}

export default class WorkbenchAppRuntimeClient {
  readonly #fetcher: typeof fetch;
  readonly #listeners = new Set<() => void>();
  readonly #loadedFrontendGeneration: WorkbenchFrontendGeneration | null;
  readonly #workspace: WorkbenchWorkspaceClient;
  #observation: Pick<ReturnType<WorkbenchWorkspaceClient["observe"]>, "release"> | null = null;
  #snapshot: WorkbenchAppRuntimeSnapshot = EMPTY;

  constructor(options: WorkbenchAppRuntimeClientOptions) {
    const fetcher = options.fetcher ?? globalThis.fetch;
    this.#fetcher = (input, init) => fetcher.call(globalThis, input, init);
    this.#loadedFrontendGeneration = options.loadedFrontendGeneration ?? null;
    this.#workspace = options.workspace;
  }

  getSnapshot = () => this.#snapshot;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async bootstrap() {
    if (this.#observation) return this.#snapshot;
    const update = () => {
      const fact = observation.getSnapshot();
      const current = fact.value?.data;
      if (!current) {
        if (fact.failure) this.#publish({ ...this.#snapshot, error: fact.failure });
        return;
      }
      this.#publish({
        dirtyScopes: current.reloadDirt.dirtyScopes, pendingScopes: current.reloadDirt.pendingScopes,
        error: fact.failure ?? current.reloadDirt.error,
        tabOutOfDate: this.#isTabOutOfDate(current.frontendGeneration),
      });
    };
    const observation = this.#workspace.observe({ kind: "runtime" }, update);
    this.#observation = observation;
    update();
    return this.#snapshot;
  }

  async reloadScopes(scopes: readonly WorkbenchReloadScope[]): Promise<WorkbenchReloadResponse> {
    const response = await this.#fetcher("/api/workbench-app-runtime", {
      body: JSON.stringify({ scopes }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 1_000) || `App reload failed with ${response.status}.`);
    const parsed = DaemonReloadResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      reportClientSchemaError("Rejected Workbench app reload response", parsed.error);
      throw new Error("The Workbench app reload response was invalid.");
    }
    return {
      appliedScopes: parsed.data.appliedScopes,
      completedAt: parsed.data.completedAt ?? null,
      error: parsed.data.error ?? null,
      ok: true,
      queuedScopes: parsed.data.queuedScopes,
      requestedScopes: parsed.data.requestedScopes,
      startedAt: parsed.data.startedAt ?? null,
      state: parsed.data.state,
    };
  }

  dispose() {
    this.#observation?.release();
    this.#observation = null;
    this.#listeners.clear();
  }

  #isTabOutOfDate(current: WorkbenchFrontendGeneration | null) {
    const loaded = this.#loadedFrontendGeneration;
    return Boolean(
      loaded
      && current
      && (
        loaded.javascript !== current.javascript
        || loaded.stylesheet !== current.stylesheet
      ),
    );
  }

  #publish(snapshot: WorkbenchAppRuntimeSnapshot) {
    if (areDeeplyEqual(this.#snapshot, snapshot)) return;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
