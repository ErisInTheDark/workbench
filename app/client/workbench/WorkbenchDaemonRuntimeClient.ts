/*
 * Exports:
 * - WorkbenchDaemonRuntimeClientOptions: app workspace and optional installation selection.
 * - default WorkbenchDaemonRuntimeClient: project source runtime facts and send app-routed reload intent.
 */
import type {
  WorkbenchReloadDirtSnapshot,
  WorkbenchReloadResponse,
  WorkbenchReloadScope,
} from "workbench-shared/reload/workbench-reload";

import {
  DaemonReloadResponseSchema,
  WorkbenchDaemonReloadDirtEnvelopeSchema,
} from "workbench-shared/workbench/daemon-reload";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type WorkbenchWorkspaceClient from "./app/WorkbenchWorkspaceClient";
import type { DaemonId } from "workbench-shared/workbench/identity";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";

const EMPTY: WorkbenchReloadDirtSnapshot = { dirtyScopes: [], error: null, pendingScopes: [] };

export interface WorkbenchDaemonRuntimeClientOptions {
  workspace: WorkbenchWorkspaceClient;
  daemonId?: DaemonId;
}

export default class WorkbenchDaemonRuntimeClient {
  #disposed = false;
  readonly #listeners = new Set<() => void>();
  readonly #serverReloadListeners = new Set<() => void>();
  #observation: Pick<ReturnType<WorkbenchWorkspaceClient["observe"]>, "release"> | null = null;
  #generation = -1;
  #revision = -1;
  #snapshot: WorkbenchReloadDirtSnapshot = EMPTY;

  constructor(private readonly options: WorkbenchDaemonRuntimeClientOptions) {}

  getSnapshot = () => this.#snapshot;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  subscribeServerReloadCompleted = (listener: () => void) => {
    this.#serverReloadListeners.add(listener);
    return () => this.#serverReloadListeners.delete(listener);
  };

  async open() {
    if (this.#observation || this.#disposed) return;
    const update = () => {
      const fact = observation.getSnapshot();
      const value = fact.value;
      if (value?.data) {
        if (this.#generation !== value.generation) {
          this.#generation = value.generation;
          this.#revision = -1;
        }
        this.acceptEnvelope({ revision: value.revision, snapshot: value.data }, "Rejected daemon runtime facts");
      }
      if (fact.failure) this.#publish({ ...this.#snapshot, error: fact.failure });
    };
    const observation = this.options.workspace.observe({ kind: "daemonRuntime", daemonId: this.options.daemonId }, update);
    this.#observation = observation;
    update();
  }

  async reloadScopes(scopes: readonly WorkbenchReloadScope[]): Promise<WorkbenchReloadResponse> {
    const response = await this.options.workspace.rpc.requestRaw({
      method: "workspace/daemon/reload", params: { daemonId: this.options.daemonId, request: { scopes: [...scopes] } },
    });
    const parsed = DaemonReloadResponseSchema.safeParse(response);
    if (!parsed.success) {
      reportClientSchemaError("Rejected Workbench reload admission response", parsed.error);
      throw new Error("The Workbench reload admission response was invalid.");
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
    this.#disposed = true;
    this.#observation?.release();
    this.#listeners.clear();
    this.#serverReloadListeners.clear();
  }

  private acceptEnvelope(value: unknown, message: string) {
    if (this.#disposed) return false;
    const parsed = WorkbenchDaemonReloadDirtEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
      reportClientSchemaError(message, parsed.error);
      return false;
    }
    if (parsed.data.revision <= this.#revision) return true;
    const completedServerReload = this.#revision >= 0
      && this.#snapshot.pendingScopes.some(scope => scope.startsWith("server:"))
      && parsed.data.snapshot.pendingScopes.length === 0
      && parsed.data.snapshot.error === null;
    this.#revision = parsed.data.revision;
    this.#publish({
      dirtyScopes: parsed.data.snapshot.dirtyScopes,
      error: parsed.data.snapshot.error ?? null,
      pendingScopes: parsed.data.snapshot.pendingScopes,
    });
    if (completedServerReload) for (const listener of this.#serverReloadListeners) listener();
    return true;
  }

  #publish(snapshot: WorkbenchReloadDirtSnapshot) {
    if (areDeeplyEqual(this.#snapshot, snapshot)) return;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
