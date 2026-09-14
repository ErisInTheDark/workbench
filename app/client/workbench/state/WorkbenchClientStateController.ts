/*
 * Exports:
 * - WorkbenchClientStateControllerOptions: HTTP, polling, and visibility seams.
 * - WorkbenchClientStateSnapshot: immutable browser projection, app-state schema capability, and visible failure.
 * - default WorkbenchClientStateController: own validated app-state bootstrap, memory, writes, and polling.
 */
import type {
  WorkbenchClientStateIdentity,
  WorkbenchClientStateMutation,
  WorkbenchClientStateRecord,
  WorkbenchClientStateResponse,
} from "workbench-shared/state/workbench-client-state";
import {
  WORKBENCH_BROWSER_STATE_HEADER,
  workbenchClientStateMutationPath,
} from "workbench-shared/state/workbench-client-state";
import {
  projectWorkbenchClientStateRows,
  workbenchClientStateRecordIdentity,
} from "workbench-shared/state/workbench-client-state-projection";

import { conformWorkbenchClientStateResponse } from "./workbench-client-state-conformance";

export interface WorkbenchClientStateSnapshot {
  daemonRegistrationId: string;
  error: string;
  records: readonly WorkbenchClientStateRecord[];
  revision: number;
  schemaVersion: number;
}

export interface WorkbenchClientStateControllerOptions {
  browserStateId?: string;
  fetcher?: typeof fetch;
  mode?: "http" | "memory";
  pollDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => number;
  cancelSchedule?: (id: number) => void;
  visibility?: {
    hidden(): boolean;
    subscribe(listener: () => void): () => void;
  };
}

function identityKey(identity: WorkbenchClientStateIdentity) {
  switch (identity.kind) {
    case "modelPreference": return `model:${identity.harness}:${identity.modelId}`;
    case "globalPreference": return `global:${identity.key}`;
    case "projectPreference": return `project:${identity.daemonRegistrationId}:${identity.projectId}:${identity.key}`;
    case "sidebarPreference": return `sidebar:${identity.daemonRegistrationId}:${identity.projectId}:${identity.key}`;
    case "sidebarFolder": return `folder:${identity.daemonRegistrationId}:${identity.projectId}:${identity.scope}:${identity.folderId}`;
    case "expandedDirectory": return `directory:${identity.daemonRegistrationId}:${identity.projectId}:${identity.path}`;
    case "fileDraft": return `file:${identity.daemonRegistrationId}:${identity.projectId}:${identity.path}`;
    case "composerDraft": return `composer:${identity.daemonRegistrationId}:${identity.projectId}:${identity.threadId}`;
    case "questionnaireDraft": return `questionnaire:${identity.daemonRegistrationId}:${identity.projectId}:${identity.threadId}:${identity.requestKey}`;
    case "lastLaunchTarget": return "launch";
  }
}

function browserVisibility(): NonNullable<WorkbenchClientStateControllerOptions["visibility"]> {
  if (typeof document === "undefined") return { hidden: () => false, subscribe: () => () => {} };
  return {
    hidden: () => document.hidden,
    subscribe: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

export default class WorkbenchClientStateController {
  readonly #browserStateId: string | undefined;
  readonly #cancelSchedule: (id: number) => void;
  readonly #fetcher: typeof fetch;
  readonly #listeners = new Set<() => void>();
  readonly #mode: "http" | "memory";
  readonly #mutationQueues = new Map<string, Promise<void>>();
  readonly #optimistic = new Map<string, { generation: number; mutation: WorkbenchClientStateMutation }>();
  readonly #pollDelayMs: number;
  readonly #records = new Map<string, WorkbenchClientStateRecord>();
  readonly #threadAliases = new Map<string, string>();
  readonly #schedule: (callback: () => void, delayMs: number) => number;
  readonly #visibility: NonNullable<WorkbenchClientStateControllerOptions["visibility"]>;
  #daemonRegistrationId = "memory";
  #disposed = false;
  #error = "";
  #mutationGeneration = 0;
  #polling = false;
  #revision = 0;
  #schemaVersion = 0;
  #scheduledPoll: number | null = null;
  #snapshot: WorkbenchClientStateSnapshot = {
    daemonRegistrationId: "memory",
    error: "",
    records: [],
    revision: 0,
    schemaVersion: 0,
  };
  #unsubscribeVisibility: (() => void) | null = null;

  constructor(options: WorkbenchClientStateControllerOptions = {}) {
    this.#browserStateId = options.browserStateId;
    this.#mode = options.mode ?? "memory";
    const fetcher = options.fetcher ?? globalThis.fetch;
    this.#fetcher = (input, init) => fetcher.call(globalThis, input, init);
    this.#pollDelayMs = options.pollDelayMs ?? 2_000;
    this.#schedule = options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.#cancelSchedule = options.cancelSchedule ?? ((id) => window.clearTimeout(id));
    this.#visibility = options.visibility ?? browserVisibility();
  }

  get daemonRegistrationId() {
    return this.#daemonRegistrationId;
  }

  getSnapshot = () => this.#snapshot;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  records<Kind extends WorkbenchClientStateRecord["kind"]>(kind: Kind) {
    return this.#snapshot.records.filter((record): record is Extract<WorkbenchClientStateRecord, { kind: Kind }> => record.kind === kind);
  }

  async bootstrap() {
    if (this.#mode === "memory") return this.#snapshot;
    const response = await this.#request("GET", "/api/workbench-client-state");
    if (response.kind !== "snapshot") throw new Error("Workbench app state bootstrap did not return a complete snapshot.");
    this.#apply(response);
    this.#unsubscribeVisibility = this.#visibility.subscribe(() => {
      if (this.#disposed || this.#visibility.hidden()) {
        this.#cancelPendingPoll();
        return;
      }
      void this.#poll();
    });
    this.#schedulePoll();
    return this.#snapshot;
  }

  async put(record: WorkbenchClientStateRecord) {
    return await this.#mutate({ action: "put", record: this.#storageIdentity(record) });
  }

  async delete(identity: WorkbenchClientStateIdentity) {
    return await this.#mutate({ action: "delete", identity: this.#storageIdentity(identity) });
  }

  rememberThreadIdentityAlias(projectId: string, storedThreadId: string, threadId: string) {
    if (storedThreadId === threadId) return;
    const key = JSON.stringify([projectId, storedThreadId]);
    if (this.#threadAliases.get(key) === threadId) return;
    this.#threadAliases.set(key, threadId);
    this.#publish();
  }

  #projectIdentity<T extends WorkbenchClientStateIdentity | WorkbenchClientStateRecord>(identity: T): T {
    if (identity.kind !== "composerDraft" && identity.kind !== "questionnaireDraft") return identity;
    const threadId = this.#threadAliases.get(JSON.stringify([identity.projectId, identity.threadId]));
    return threadId ? { ...identity, threadId } : identity;
  }

  #storageIdentity<T extends WorkbenchClientStateIdentity | WorkbenchClientStateRecord>(identity: T): T {
    if (identity.kind !== "composerDraft" && identity.kind !== "questionnaireDraft") return identity;
    const address: Extract<WorkbenchClientStateIdentity, { kind: "composerDraft" | "questionnaireDraft" }> = identity;
    const key = identityKey(this.#projectIdentity(address));
    for (const record of this.#records.values()) {
      if ((record.kind === "composerDraft" || record.kind === "questionnaireDraft")
        && identityKey(this.#projectIdentity(record)) === key) return { ...identity, threadId: record.threadId };
    }
    return identity;
  }

  dispose() {
    this.#disposed = true;
    this.#cancelPendingPoll();
    this.#unsubscribeVisibility?.();
    this.#unsubscribeVisibility = null;
    this.#listeners.clear();
    this.#threadAliases.clear();
  }

  async #mutate(mutation: WorkbenchClientStateMutation) {
    if (this.#mode === "memory") {
      this.#revision += 1;
      if (mutation.action === "put") {
        this.#records.set(identityKey(workbenchClientStateRecordIdentity(mutation.record)), mutation.record);
      }
      else this.#records.delete(identityKey(mutation.identity));
      this.#publish();
      return this.#snapshot;
    }
    const identity = mutation.action === "put"
      ? workbenchClientStateRecordIdentity(mutation.record)
      : mutation.identity;
    const key = identityKey(identity);
    const generation = ++this.#mutationGeneration;
    this.#optimistic.set(key, { generation, mutation });
    this.#publish();
    const previous = this.#mutationQueues.get(key) ?? Promise.resolve();
    const operation = previous.then(async () => {
      try {
        const response = await this.#request(
          mutation.action === "put" ? "PUT" : "DELETE",
          workbenchClientStateMutationPath(
            mutation.action === "put" ? mutation.record.kind : mutation.identity.kind,
          ),
          mutation,
        );
        this.#apply(response);
        this.#applyConfirmedMutation(mutation);
        if (this.#optimistic.get(key)?.generation === generation) {
          this.#optimistic.delete(key);
          this.#publish();
        }
        return this.#snapshot;
      } catch (error) {
        if (this.#optimistic.get(key)?.generation === generation) {
          this.#optimistic.delete(key);
          this.#publish();
        }
        throw error;
      }
    });
    const queued = operation.then(() => undefined, () => undefined);
    this.#mutationQueues.set(key, queued);
    void queued.finally(() => {
      if (this.#mutationQueues.get(key) === queued) this.#mutationQueues.delete(key);
    });
    return await operation;
  }

  async #poll() {
    if (this.#disposed || this.#mode === "memory" || this.#visibility.hidden() || this.#polling) return;
    this.#cancelPendingPoll();
    this.#polling = true;
    try {
      const response = await this.#request("GET", `/api/workbench-client-state?sinceRevision=${this.#revision}`);
      this.#apply(response);
      this.#setError("");
    } catch (error) {
      this.#setError(error instanceof Error ? error.message : "Workbench app state polling failed.");
    } finally {
      this.#polling = false;
      this.#schedulePoll();
    }
  }

  #schedulePoll() {
    if (this.#disposed || this.#mode === "memory" || this.#visibility.hidden() || this.#scheduledPoll !== null) return;
    this.#scheduledPoll = this.#schedule(() => {
      this.#scheduledPoll = null;
      void this.#poll();
    }, this.#pollDelayMs);
  }

  #cancelPendingPoll() {
    if (this.#scheduledPoll === null) return;
    this.#cancelSchedule(this.#scheduledPoll);
    this.#scheduledPoll = null;
  }

  async #request(method: "DELETE" | "GET" | "PUT", url: string, mutation?: WorkbenchClientStateMutation) {
    const body = mutation
      ? mutation.action === "put" ? mutation.record : mutation.identity
      : undefined;
    const response = await this.#fetcher(url, {
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(this.#browserStateId ? { [WORKBENCH_BROWSER_STATE_HEADER]: this.#browserStateId } : {}),
      },
      method,
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message.slice(0, 1_000) || `Workbench app state request failed with ${response.status}.`);
    }
    const conformed = conformWorkbenchClientStateResponse(await response.json());
    if (conformed.repairedPaths.length || !conformed.success) {
      console.warn("Workbench app-state response required schema conformance.", {
        issues: "data" in conformed ? [] : conformed.issues.slice(0, 20),
        repairedPaths: conformed.repairedPaths.slice(0, 20),
      });
    }
    if (!("data" in conformed)) {
      throw new Error("The Workbench app-state response was invalid.");
    }
    return conformed.data;
  }

  #apply(response: WorkbenchClientStateResponse) {
    if (response.revision < this.#revision) return;
    if (this.#daemonRegistrationId !== "memory" && response.daemonRegistrationId !== this.#daemonRegistrationId) {
      throw new Error("Workbench app-state daemon registration changed during this browser session.");
    }
    this.#daemonRegistrationId = response.daemonRegistrationId;
    this.#schemaVersion = response.schemaVersion ?? 0;
    if (response.kind === "snapshot") this.#records.clear();
    for (const change of projectWorkbenchClientStateRows(response.rows)) {
      if (response.kind === "delta" && change.revision <= this.#revision) continue;
      if (change.change === "upsert") {
        this.#records.set(identityKey(workbenchClientStateRecordIdentity(change.record)), change.record);
      } else {
        this.#records.delete(identityKey(change.identity));
      }
    }
    this.#revision = response.revision;
    this.#publish();
  }

  #setError(error: string) {
    if (this.#error === error) return;
    this.#error = error;
    this.#publish();
  }

  #applyConfirmedMutation(mutation: WorkbenchClientStateMutation) {
    if (mutation.action === "put") {
      this.#records.set(
        identityKey(workbenchClientStateRecordIdentity(mutation.record)),
        mutation.record,
      );
    } else {
      this.#records.delete(identityKey(mutation.identity));
    }
  }

  #publish() {
    const projectedRecords = new Map(this.#records);
    for (const [key, { mutation }] of this.#optimistic) {
      if (mutation.action === "put") projectedRecords.set(key, mutation.record);
      else projectedRecords.delete(key);
    }
    this.#snapshot = {
      daemonRegistrationId: this.#daemonRegistrationId,
      error: this.#error,
      records: [...projectedRecords.values()].map((record) => this.#projectIdentity(record)),
      revision: this.#revision,
      schemaVersion: this.#schemaVersion,
    };
    for (const listener of this.#listeners) listener();
  }
}
