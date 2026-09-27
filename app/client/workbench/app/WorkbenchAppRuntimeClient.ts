/*
 * Exports:
 * - WorkbenchAppRuntimeClientOptions: HTTP, polling, and visibility seams.
 * - default WorkbenchAppRuntimeClient: own app reload dirt, tab freshness, and reload requests.
 */
import type { WorkbenchReloadResponse, WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";
import { WorkbenchAppRuntimeResponseSchema } from "workbench-shared/http/workbench-app-rpc";

import type {
  WorkbenchAppRuntimeSnapshot,
  WorkbenchFrontendGeneration,
} from "workbench-shared/types";
import { DaemonReloadResponseSchema } from "workbench-shared/workbench/daemon-reload";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";

const EMPTY: WorkbenchAppRuntimeSnapshot = {
  dirtyScopes: [],
  error: null,
  pendingScopes: [],
  tabOutOfDate: false,
};

export interface WorkbenchAppRuntimeClientOptions {
  cancelSchedule?: (id: number) => void;
  fetcher?: typeof fetch;
  loadedFrontendGeneration?: WorkbenchFrontendGeneration | null;
  pollDelayMs?: number;
  rpc?: WorkbenchAppRpcClient;
  schedule?: (callback: () => void, delayMs: number) => number;
  visibility?: {
    hidden(): boolean;
    subscribe(listener: () => void): () => void;
  };
}

function browserVisibility(): NonNullable<WorkbenchAppRuntimeClientOptions["visibility"]> {
  return {
    hidden: () => typeof document !== "undefined" && document.hidden,
    subscribe: (listener) => {
      if (typeof document === "undefined") return () => {};
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

export default class WorkbenchAppRuntimeClient {
  readonly #cancelSchedule: (id: number) => void;
  #disposed = false;
  readonly #fetcher: typeof fetch;
  readonly #listeners = new Set<() => void>();
  readonly #loadedFrontendGeneration: WorkbenchFrontendGeneration | null;
  #polling = false;
  readonly #pollDelayMs: number;
  readonly #rpc: WorkbenchAppRpcClient | null;
  readonly #schedule: (callback: () => void, delayMs: number) => number;
  #scheduled: number | null = null;
  #refreshAgain = false;
  #snapshot: WorkbenchAppRuntimeSnapshot = EMPTY;
  #unsubscribe: (() => void) | null = null;
  #unsubscribeRpcEvent: (() => void) | null = null;
  #unsubscribeRpcReconnect: (() => void) | null = null;
  readonly #visibility: NonNullable<WorkbenchAppRuntimeClientOptions["visibility"]>;

  constructor(options: WorkbenchAppRuntimeClientOptions = {}) {
    const fetcher = options.fetcher ?? globalThis.fetch;
    this.#fetcher = (input, init) => fetcher.call(globalThis, input, init);
    this.#loadedFrontendGeneration = options.loadedFrontendGeneration ?? null;
    this.#rpc = options.rpc?.available ? options.rpc : null;
    this.#pollDelayMs = options.pollDelayMs ?? 2_000;
    this.#schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number);
    this.#cancelSchedule = options.cancelSchedule ?? ((id) => globalThis.clearTimeout(id));
    this.#visibility = options.visibility ?? browserVisibility();
  }

  getSnapshot = () => this.#snapshot;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async bootstrap() {
    let ready = false;
    let changedDuringBootstrap = false;
    if (this.#rpc) {
      this.#unsubscribeRpcEvent = this.#rpc.onEvent(event => {
        if (event.kind !== "runtime") return;
        if (ready) void this.#poll();
        else changedDuringBootstrap = true;
      });
      this.#unsubscribeRpcReconnect = this.#rpc.onReconnect(() => {
        if (ready) void this.#poll();
        else changedDuringBootstrap = true;
      });
    }
    try {
      await this.#refresh();
      ready = true;
      this.#unsubscribe = this.#visibility.subscribe(() => {
        if (this.#disposed || this.#visibility.hidden()) {
          this.#cancelPoll();
          return;
        }
        void this.#poll();
      });
      if (changedDuringBootstrap) void this.#poll();
      this.#schedulePoll();
      return this.#snapshot;
    } catch (error) {
      this.#unsubscribeRpcEvent?.();
      this.#unsubscribeRpcReconnect?.();
      this.#unsubscribeRpcEvent = null;
      this.#unsubscribeRpcReconnect = null;
      throw error;
    }
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
    this.#disposed = true;
    this.#cancelPoll();
    this.#unsubscribe?.();
    this.#unsubscribeRpcEvent?.();
    this.#unsubscribeRpcReconnect?.();
    this.#listeners.clear();
  }

  async #poll() {
    if (this.#disposed || this.#visibility.hidden()) return;
    if (this.#polling) {
      if (this.#rpc) this.#refreshAgain = true;
      return;
    }
    this.#cancelPoll();
    this.#polling = true;
    let succeeded = false;
    try {
      succeeded = await this.#refresh();
    } finally {
      this.#polling = false;
      if (this.#rpc && succeeded && this.#refreshAgain) {
        this.#refreshAgain = false;
        void this.#poll();
      } else {
        this.#refreshAgain = false;
        this.#schedulePoll();
      }
    }
  }

  async #refresh() {
    try {
      const value = this.#rpc
        ? await this.#rpc.requestRaw({ method: "app/runtime/read", params: {} })
        : await (async () => {
          const response = await this.#fetcher("/api/workbench-app-runtime?version=4");
          if (!response.ok) throw new Error((await response.text()).slice(0, 1_000)
            || `App runtime request failed with ${response.status}.`);
          return await response.json() as unknown;
        })();
      const parsed = WorkbenchAppRuntimeResponseSchema.safeParse(value);
      if (!parsed.success) {
        reportClientSchemaError("Rejected Workbench app runtime response", parsed.error);
        throw new Error("The Workbench app runtime response was invalid.");
      }
      this.#publish({
        dirtyScopes: parsed.data.reloadDirt.dirtyScopes,
        error: parsed.data.reloadDirt.error ?? null,
        pendingScopes: parsed.data.reloadDirt.pendingScopes,
        tabOutOfDate: this.#isTabOutOfDate(parsed.data.frontendGeneration),
      });
      return true;
    } catch (error) {
      this.#publish({
        ...this.#snapshot,
        error: error instanceof Error ? error.message.slice(0, 500) : "Workbench app runtime polling failed.",
      });
      return false;
    }
  }

  #schedulePoll() {
    if (this.#disposed || this.#rpc || this.#visibility.hidden() || this.#scheduled !== null) return;
    this.#scheduled = this.#schedule(() => {
      this.#scheduled = null;
      void this.#poll();
    }, this.#pollDelayMs);
  }

  #cancelPoll() {
    if (this.#scheduled === null) return;
    this.#cancelSchedule(this.#scheduled);
    this.#scheduled = null;
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
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
