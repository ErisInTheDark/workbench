/*
 * Exports:
 * - WorkbenchAppRuntimeClientOptions: HTTP, polling, and visibility seams.
 * - default WorkbenchAppRuntimeClient: own app reload dirt, tab freshness, and reload requests.
 */
import { z } from "zod";

import type { WorkbenchReloadResponse, WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";

import type {
  WorkbenchAppRuntimeSnapshot,
  WorkbenchFrontendGeneration,
} from "workbench-shared/types";
import { DaemonReloadResponseSchema } from "workbench-shared/workbench/daemon-reload";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";

const ReloadDirtSchema = z.object({
  dirtyScopes: z.array(z.object({
    dependantScopes: z.array(z.string().regex(/^(?:client|host):[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u)).default([]),
    description: z.string(),
    destructive: z.boolean(),
    scope: z.string().regex(/^(?:client|host):[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u),
  }).strict()),
  error: z.string().max(500).nullable(),
  pendingScopes: z.array(z.string().regex(/^(?:client|host):[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u)),
}).strict();
const FrontendGenerationSchema = z.object({
  javascript: z.string().min(1).max(200),
  stylesheet: z.string().min(1).max(200),
}).strict();
const RuntimeResponseSchema = z.object({
  frontendGeneration: FrontendGenerationSchema.nullable().optional().default(null),
  reloadDirt: ReloadDirtSchema,
}).strict();
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
  readonly #schedule: (callback: () => void, delayMs: number) => number;
  #scheduled: number | null = null;
  #snapshot: WorkbenchAppRuntimeSnapshot = EMPTY;
  #unsubscribe: (() => void) | null = null;
  readonly #visibility: NonNullable<WorkbenchAppRuntimeClientOptions["visibility"]>;

  constructor(options: WorkbenchAppRuntimeClientOptions = {}) {
    const fetcher = options.fetcher ?? globalThis.fetch;
    this.#fetcher = (input, init) => fetcher.call(globalThis, input, init);
    this.#loadedFrontendGeneration = options.loadedFrontendGeneration ?? null;
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
    await this.#refresh();
    this.#unsubscribe = this.#visibility.subscribe(() => {
      if (this.#disposed || this.#visibility.hidden()) {
        this.#cancelPoll();
        return;
      }
      void this.#poll();
    });
    this.#schedulePoll();
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
    this.#disposed = true;
    this.#cancelPoll();
    this.#unsubscribe?.();
    this.#listeners.clear();
  }

  async #poll() {
    if (this.#disposed || this.#polling || this.#visibility.hidden()) return;
    this.#cancelPoll();
    this.#polling = true;
    try {
      await this.#refresh();
    } finally {
      this.#polling = false;
      this.#schedulePoll();
    }
  }

  async #refresh() {
    try {
      const response = await this.#fetcher("/api/workbench-app-runtime?version=4");
      if (!response.ok) throw new Error((await response.text()).slice(0, 1_000) || `App runtime request failed with ${response.status}.`);
      const parsed = RuntimeResponseSchema.safeParse(await response.json());
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
    } catch (error) {
      this.#publish({
        ...this.#snapshot,
        error: error instanceof Error ? error.message.slice(0, 500) : "Workbench app runtime polling failed.",
      });
    }
  }

  #schedulePoll() {
    if (this.#disposed || this.#visibility.hidden() || this.#scheduled !== null) return;
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
