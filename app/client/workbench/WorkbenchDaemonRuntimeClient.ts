/*
 * Exports:
 * - WorkbenchDaemonRuntimeClientOptions: shared-socket request seam for browser reload runtime tests.
 * - default WorkbenchDaemonRuntimeClient: own ordered reload dirt, server-completion signals, fallback, and reload admission.
 */
import type {
  WorkbenchReloadDirtSnapshot,
  WorkbenchReloadResponse,
  WorkbenchReloadScope,
} from "workbench-shared/reload/workbench-reload";

import {
  DaemonReloadResponseSchema,
  WorkbenchDaemonReloadDirtEnvelopeSchema,
  WORKBENCH_RELOAD_DIRT_READ_METHOD,
  WORKBENCH_RELOAD_METHOD,
} from "workbench-shared/workbench/daemon-reload";
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";

const EMPTY: WorkbenchReloadDirtSnapshot = { dirtyScopes: [], error: null, pendingScopes: [] };

export interface WorkbenchDaemonRuntimeClientOptions {
  request(method: string, params: unknown): Promise<unknown>;
}

function isUnsupportedRead(error: unknown) {
  return error instanceof WorkbenchDaemonRequestError && error.code === -32601;
}

export default class WorkbenchDaemonRuntimeClient {
  #dedicatedObservation = false;
  #disposed = false;
  readonly #listeners = new Set<() => void>();
  readonly #serverReloadListeners = new Set<() => void>();
  readonly #request: WorkbenchDaemonRuntimeClientOptions["request"];
  #revision = -1;
  #snapshot: WorkbenchReloadDirtSnapshot = EMPTY;

  constructor({ request }: WorkbenchDaemonRuntimeClientOptions) {
    this.#request = request;
  }

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
    try {
      const response = await this.#request(WORKBENCH_RELOAD_DIRT_READ_METHOD, {});
      return this.acceptEnvelope(response, "Rejected Workbench daemon reload dirt response");
    } catch (error) {
      if (isUnsupportedRead(error)) {
        this.#dedicatedObservation = false;
        return false;
      }
      this.#publish({
        ...this.#snapshot,
        error: error instanceof Error ? error.message.slice(0, 500) : "Workbench daemon reload observation failed.",
      });
      throw error;
    }
  }

  resetConnection() {
    this.#dedicatedObservation = false;
    this.#revision = -1;
  }

  acceptLegacy(snapshot: WorkbenchReloadDirtSnapshot | null | undefined) {
    if (this.#disposed || this.#dedicatedObservation || !snapshot) return;
    this.#publish(snapshot);
  }

  acceptUpdate(value: unknown) {
    return this.acceptEnvelope(value, "Rejected Workbench daemon reload dirt update");
  }

  async reloadScopes(scopes: readonly WorkbenchReloadScope[]): Promise<WorkbenchReloadResponse> {
    const response = await this.#request(WORKBENCH_RELOAD_METHOD, { scopes });
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
    this.#dedicatedObservation = true;
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
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
