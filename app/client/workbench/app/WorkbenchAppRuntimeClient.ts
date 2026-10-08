/*
 * Exports:
 * - WorkbenchAppRuntimeClientOptions: workspace facts, loaded bundle identity and reload handoff transport.
 * - default WorkbenchAppRuntimeClient: project pushed runtime facts and the app's reload/pull operation, and send reload, reload-all and pull intents.
 */
import {
  IDLE_RELOAD_OPERATION,
  type WorkbenchReloadOperation, type WorkbenchReloadResponse, type WorkbenchReloadScope,
} from "workbench-shared/reload/workbench-reload";
import { WorkbenchAppOperationAdmissionSchema, type WorkbenchAppRpcIntent } from "workbench-shared/http/workbench-app-rpc";

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
  readonly #operationListeners = new Set<() => void>();
  #operationObservation: Pick<ReturnType<WorkbenchWorkspaceClient["observe"]>, "release"> | null = null;
  #operation: WorkbenchReloadOperation = IDLE_RELOAD_OPERATION;

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

  getOperation = () => this.#operation;

  subscribeOperation = (listener: () => void) => {
    this.#operationListeners.add(listener);
    return () => this.#operationListeners.delete(listener);
  };

  async reloadAll() {
    await this.#admit({ method: "app/reload/all", params: {} });
  }

  async pull({ reload }: { reload: boolean }) {
    await this.#admit({ method: "app/update/pull", params: { reload } });
  }

  async #admit(intent: Extract<WorkbenchAppRpcIntent, { method: "app/reload/all" | "app/update/pull" }>) {
    const parsed = WorkbenchAppOperationAdmissionSchema.safeParse(await this.#workspace.rpc.requestRaw(intent));
    if (!parsed.success) {
      reportClientSchemaError("Rejected Workbench app operation admission", parsed.error);
      throw new Error("The Workbench app operation admission was invalid.");
    }
  }

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
    // Stale values survive reconnects: an operation that dropped the socket stays visible until facts resume.
    const operationChanged = () => {
      const value = operationObservation.getSnapshot().value;
      if (!value?.data || areDeeplyEqual(this.#operation, value.data)) return;
      this.#operation = value.data;
      for (const listener of this.#operationListeners) listener();
    };
    const operationObservation = this.#workspace.observe({ kind: "reloadOperation" }, operationChanged);
    this.#operationObservation = operationObservation;
    operationChanged();
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
    this.#operationObservation?.release();
    this.#operationObservation = null;
    this.#listeners.clear();
    this.#operationListeners.clear();
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
