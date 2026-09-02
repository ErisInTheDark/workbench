/*
 * Exports:
 * - WorkbenchAppRuntimeClientOptions: HTTP, polling, and visibility seams. Keywords: app, reload, browser, test.
 * - default WorkbenchAppRuntimeClient: own app reload-dirt observation and reload requests. Keywords: app, reload, lifecycle.
 */
import { z } from "zod";

import type { WorkbenchReloadDirtSnapshot, WorkbenchReloadResponse, WorkbenchReloadScope } from "workbench-shared/reload/workbench-reload";

import { OrchestratorReloadResponseSchema } from "../orchestrator-reload";
import reportClientSchemaError from "../report-client-schema-error";

const ReloadDirtSchema = z.object({
  dirtyScopes: z.array(z.object({
    dependantScopes: z.array(z.string().regex(/^client:[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u)).default([]),
    description: z.string(),
    destructive: z.boolean(),
    scope: z.string().regex(/^client:[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u),
  }).strict()),
  error: z.string().max(500).nullable(),
  pendingScopes: z.array(z.string().regex(/^client:[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/u)),
}).strict();
const RuntimeResponseSchema = z.object({ reloadDirt: ReloadDirtSchema }).strict();
const EMPTY: WorkbenchReloadDirtSnapshot = { dirtyScopes: [], error: null, pendingScopes: [] };

export interface WorkbenchAppRuntimeClientOptions {
  cancelSchedule?: (id: number) => void;
  fetcher?: typeof fetch;
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
  #polling = false;
  readonly #pollDelayMs: number;
  readonly #schedule: (callback: () => void, delayMs: number) => number;
  #scheduled: number | null = null;
  #snapshot: WorkbenchReloadDirtSnapshot = EMPTY;
  #unsubscribe: (() => void) | null = null;
  readonly #visibility: NonNullable<WorkbenchAppRuntimeClientOptions["visibility"]>;

  constructor(options: WorkbenchAppRuntimeClientOptions = {}) {
    const fetcher = options.fetcher ?? globalThis.fetch;
    this.#fetcher = (input, init) => fetcher.call(globalThis, input, init);
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
    const parsed = OrchestratorReloadResponseSchema.safeParse(await response.json());
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
      const response = await this.#fetcher("/api/workbench-app-runtime?version=2");
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

  #publish(snapshot: WorkbenchReloadDirtSnapshot) {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
