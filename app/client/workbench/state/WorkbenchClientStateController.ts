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
  WorkbenchClientStateAttachmentIdentity,
  WorkbenchDaemonRegistration,
  WorkbenchProjectRemap,
} from "workbench-shared/state/workbench-client-state";
import {
  WORKBENCH_BROWSER_STATE_HEADER,
  WorkbenchDaemonRegistrationRequestSchema,
  WorkbenchProjectRemapSchema,
  workbenchClientStateMutationPath,
  workbenchClientStateAttachmentUrl,
} from "workbench-shared/state/workbench-client-state";
import {
  projectWorkbenchClientStateRows,
  workbenchClientStateRecordIdentity,
} from "workbench-shared/state/workbench-client-state-projection";

import { conformWorkbenchClientStateResponse } from "./workbench-client-state-conformance";
import type { WorkbenchProjectAlias } from "workbench-shared/types";
import { composeProjectAliases } from "workbench-shared/workbench/project/project-aliases";
import appStateReleases from "workbench-shared/state/workbench-app-state-releases";
import type WorkbenchAppRpcClient from "../app/WorkbenchAppRpcClient";

export interface WorkbenchClientStateSnapshot {
  attachmentsAsUrls: boolean;
  daemonRegistrationId: string;
  error: string;
  records: readonly WorkbenchClientStateRecord[];
  registrations: readonly WorkbenchDaemonRegistration[];
  revision: number;
  schemaVersion: number;
}

export interface WorkbenchClientStateControllerOptions {
  browserStateId?: string;
  fetcher?: typeof fetch;
  mode?: "http" | "memory";
  rpc?: WorkbenchAppRpcClient;
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
    case "modelPreference": return JSON.stringify([identity.kind, identity.harness, identity.modelId]);
    case "globalPreference": return JSON.stringify([identity.kind, identity.key]);
    case "projectPreference":
    case "sidebarPreference": return JSON.stringify([identity.kind, identity.daemonRegistrationId, identity.projectId, identity.key]);
    case "sidebarFolder": return JSON.stringify([identity.kind, identity.daemonRegistrationId, identity.projectId, identity.scope, identity.folderId]);
    case "expandedDirectory":
    case "fileDraft": return JSON.stringify([identity.kind, identity.daemonRegistrationId, identity.projectId, identity.path]);
    case "composerDraft": return JSON.stringify([identity.kind, identity.daemonRegistrationId, identity.projectId, identity.threadId]);
    case "questionnaireDraft": return JSON.stringify([identity.kind, identity.daemonRegistrationId, identity.projectId, identity.threadId, identity.requestKey]);
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
  readonly #rpc: WorkbenchAppRpcClient | null;
  readonly #records = new Map<string, WorkbenchClientStateRecord>();
  readonly #registrationRequests = new Map<string, Promise<string>>();
  readonly #threadAliases = new Map<string, Map<string, Map<string, string>>>();
  readonly #projectAliases = new Map<string, Map<string, WorkbenchProjectAlias["projectId"]>>();
  #projectRemap: Promise<void> | null = null;
  readonly #schedule: (callback: () => void, delayMs: number) => number;
  readonly #visibility: NonNullable<WorkbenchClientStateControllerOptions["visibility"]>;
  #daemonRegistrationId = "memory";
  #disposed = false;
  #error = "";
  #mutationGeneration = 0;
  #polling = false;
  #revision = 0;
  #notifiedRevision = 0;
  #registrations: WorkbenchClientStateSnapshot["registrations"] = [];
  #schemaVersion = 0;
  #attachmentsAsUrls = false;
  #requestCapabilities: "2" | "3" = "3";
  #scheduledPoll: number | null = null;
  #snapshot: WorkbenchClientStateSnapshot = {
    attachmentsAsUrls: false,
    daemonRegistrationId: "memory",
    error: "",
    records: [],
    registrations: [],
    revision: 0,
    schemaVersion: 0,
  };
  #unsubscribeVisibility: (() => void) | null = null;
  #unsubscribeRpcEvent: (() => void) | null = null;
  #unsubscribeRpcReconnect: (() => void) | null = null;

  constructor(options: WorkbenchClientStateControllerOptions = {}) {
    this.#browserStateId = options.browserStateId;
    this.#mode = options.mode ?? "memory";
    this.#rpc = this.#mode === "http" && options.rpc?.available ? options.rpc : null;
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
    let ready = false;
    let reconnectDuringBootstrap = false;
    if (this.#rpc) {
      this.#unsubscribeRpcEvent = this.#rpc.onEvent(event => {
        if (event.kind !== "state" || event.revision <= this.#revision) return;
        this.#notifiedRevision = Math.max(this.#notifiedRevision, event.revision);
        if (ready) void this.#poll();
      });
      this.#unsubscribeRpcReconnect = this.#rpc.onReconnect(() => {
        if (ready) void this.#poll();
        else reconnectDuringBootstrap = true;
      });
    }
    try {
      let response = await this.#request("GET", "/api/workbench-client-state");
      if (!this.#rpc && !response.registrations
        && (response.schemaVersion ?? 0) >= appStateReleases.durableDaemonRegistrations.version
        && this.#requestCapabilities === "3") {
        this.#requestCapabilities = "2";
        response = await this.#request("GET", "/api/workbench-client-state");
      }
      if (response.kind !== "snapshot") throw new Error("Workbench app state bootstrap did not return a complete snapshot.");
      this.#apply(response);
      ready = true;
      this.#unsubscribeVisibility = this.#visibility.subscribe(() => {
        if (this.#disposed || this.#visibility.hidden()) {
          this.#cancelPendingPoll();
          return;
        }
        void this.#poll();
      });
      if (reconnectDuringBootstrap || this.#notifiedRevision > this.#revision) void this.#poll();
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

  async put(record: WorkbenchClientStateRecord) {
    if (this.#projectRemap) await this.#projectRemap;
    return await this.#mutate({ action: "put", record: this.#storageIdentity(record) });
  }

  async delete(identity: WorkbenchClientStateIdentity) {
    if (this.#projectRemap) await this.#projectRemap;
    return await this.#mutate({ action: "delete", identity: this.#storageIdentity(identity) });
  }

  supportsAttachmentUrls() {
    return this.#attachmentsAsUrls && this.#mode === "http";
  }

  async uploadDraftAttachment(
    identity: WorkbenchClientStateAttachmentIdentity,
    attachmentId: string,
    sourceUrl: string,
  ) {
    if (!this.supportsAttachmentUrls()) throw new Error("App draft image uploads are unavailable.");
    if (this.#projectRemap) await this.#projectRemap;
    const owner = this.#storageIdentity(identity);
    const source = await this.#fetcher(sourceUrl);
    if (!source.ok) throw new Error("The pasted draft image could not be read.");
    const mediaType = source.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
      throw new Error("Draft image type is unsupported.");
    }
    const content = await source.arrayBuffer();
    if (!content.byteLength || content.byteLength > 20 * 1024 * 1024) {
      throw new Error("Draft image exceeds its size limit.");
    }
    const url = workbenchClientStateAttachmentUrl(this.#browserStateId ?? "shared", owner, attachmentId);
    const response = await this.#fetcher(url, {
      method: "PUT",
      headers: {
        "Content-Type": mediaType,
        ...(this.#browserStateId ? { [WORKBENCH_BROWSER_STATE_HEADER]: this.#browserStateId } : {}),
      },
      body: content,
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 1_000)
      || `Draft image upload failed with HTTP ${response.status}.`);
    this.#apply(this.#parseResponse(await response.json()));
    return url;
  }

  async resolveDraftAttachmentUrl(url: string) {
    if (!url.startsWith("/api/workbench-client-state/attachment?")) return url;
    const response = await this.#fetcher(url);
    if (!response.ok) throw new Error("The saved draft image is unavailable.");
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
      throw new Error("The saved draft image type is unsupported.");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const parts: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
    }
    return `data:${mediaType};base64,${btoa(parts.join(""))}`;
  }

  rememberThreadIdentityAlias(projectId: string, storedThreadId: string, threadId: string, daemonRegistrationId = this.#daemonRegistrationId) {
    if (storedThreadId === threadId) return;
    projectId = this.resolveProjectId(projectId, daemonRegistrationId);
    const scoped = this.#threadAliases.get(daemonRegistrationId) ?? new Map<string, Map<string, string>>();
    const aliases = scoped.get(projectId) ?? new Map<string, string>();
    if (aliases.get(storedThreadId) === threadId) return;
    aliases.set(storedThreadId, threadId);
    scoped.set(projectId, aliases);
    this.#threadAliases.set(daemonRegistrationId, scoped);
    this.#publish();
  }

  resolveProjectId(projectId: string, daemonRegistrationId = this.#daemonRegistrationId) {
    return this.#projectAliases.get(daemonRegistrationId)?.get(projectId) ?? projectId;
  }

  async ensureDaemonRegistration(daemonId: string, attachedLocal: boolean): Promise<string> {
    const request = WorkbenchDaemonRegistrationRequestSchema.parse({ daemonId, attachedLocal });
    const existing = this.#registrations.find(item => item.daemonId === request.daemonId);
    if (existing) return existing.id;
    if (this.#mode === "memory") throw new Error("A memory app state has no durable daemon registration.");
    const pending = this.#registrationRequests.get(daemonId);
    if (pending) return await pending;
    const operation = (async () => {
      if (this.#disposed) throw new Error("Workbench app state is disposed.");
      let state: WorkbenchClientStateResponse;
      if (this.#rpc) {
        state = this.#parseResponse(await this.#rpc.requestRaw({
          method: "app/state/register",
          params: { browserStateId: this.#browserStateId ?? null, request },
        }));
      } else {
        const response = await this.#fetcher("/api/workbench-client-state/daemon-register", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.#browserStateId ? { [WORKBENCH_BROWSER_STATE_HEADER]: this.#browserStateId } : {}),
          },
          body: JSON.stringify(request),
        });
        if (!response.ok) throw new Error((await response.text()).slice(0, 1_000)
          || `Daemon registration failed with HTTP ${response.status}.`);
        state = await this.#request("GET", "/api/workbench-client-state");
      }
      if (this.#disposed) throw new Error("Workbench app state was disposed during daemon registration.");
      if (state.kind !== "snapshot") throw new Error("Daemon registration did not return a complete app state.");
      this.#apply(state);
      const registered = this.#registrations.find(item => item.daemonId === daemonId);
      if (!registered) throw new Error("Registered daemon is missing from app state.");
      this.#setError("");
      return registered.id;
    })().catch((error: unknown) => {
      if (!this.#disposed) this.#setError(error instanceof Error ? error.message : "Daemon registration failed.");
      throw error;
    }).finally(() => { this.#registrationRequests.delete(daemonId); });
    this.#registrationRequests.set(daemonId, operation);
    return await operation;
  }

  getProjectAliases(daemonRegistrationId = this.#daemonRegistrationId): readonly WorkbenchProjectAlias[] {
    return [...(this.#projectAliases.get(daemonRegistrationId) ?? [])].map(([alias, projectId]) => ({ alias, projectId }));
  }

  async adoptProjectAliases(aliases: readonly WorkbenchProjectAlias[], daemonRegistrationId = this.#daemonRegistrationId) {
    if (!aliases.length) return;
    const prior = this.#projectRemap;
    const writes = [...this.#mutationQueues.values()];
    const operation = (async () => {
      await prior;
      await Promise.all(writes);
      if (this.#disposed) throw new Error("Workbench app state is disposed.");
      const request = WorkbenchProjectRemapSchema.parse({ daemonRegistrationId, aliases });
      const composed = composeProjectAliases(this.getProjectAliases(daemonRegistrationId), request.aliases);
      const additions = composed.changes;
      if (!additions.length) return;
      const mapping = new Map(composed.aliases.map(item => [item.alias, item.projectId]));
      this.#remappedThreadAliases(mapping, daemonRegistrationId);
      if (this.#mode === "memory") {
        const keys = new Set<string>();
        for (const record of this.#records.values()) {
          const next = "projectId" in record && record.daemonRegistrationId === daemonRegistrationId
            ? { ...record, projectId: mapping.get(record.projectId) ?? record.projectId } : record;
          const key = identityKey(workbenchClientStateRecordIdentity(next));
          if (keys.has(key)) throw new Error("Project adoption conflicts with existing saved state.");
          keys.add(key);
        }
      }
      const response = this.#mode === "http"
        ? await this.#request("POST", "/api/workbench-client-state/project-remap", request)
        : null;
      if (this.#disposed) throw new Error("Workbench app state was disposed during project adoption.");
      // Thread identities may arrive while the app server is persisting the remap.
      const threadAliases = this.#remappedThreadAliases(mapping, daemonRegistrationId);
      if (response) {
        if (response.kind !== "snapshot") throw new Error("Project adoption did not return a complete snapshot.");
        this.#apply(response, false);
      }
      const scopedAliases = this.#projectAliases.get(daemonRegistrationId) ?? new Map<string, WorkbenchProjectAlias["projectId"]>();
      for (const alias of additions) scopedAliases.set(alias.alias, alias.projectId);
      this.#projectAliases.set(daemonRegistrationId, scopedAliases);
      this.#threadAliases.set(daemonRegistrationId, threadAliases);
      const records = [...this.#records.values()].map(record => this.#canonicalProject(record));
      this.#records.clear();
      for (const record of records) this.#records.set(identityKey(workbenchClientStateRecordIdentity(record)), record);
      this.#publish();
      this.#setError("");
    })().catch((error: unknown) => {
      this.#setError(error instanceof Error ? error.message : "Project state adoption failed.");
      throw error;
    });
    // The adoption caller owns failure. Queued edits continue at the retained
    // identity if adoption fails, rather than disappearing behind a rejected gate.
    const boundary = operation.then(() => undefined, () => undefined);
    this.#projectRemap = boundary;
    void boundary.then(() => {
      if (this.#projectRemap === boundary) this.#projectRemap = null;
      if (this.#rpc && this.#notifiedRevision > this.#revision) void this.#poll();
      else this.#schedulePoll();
    });
    await operation;
  }

  #canonicalProject<T extends WorkbenchClientStateIdentity | WorkbenchClientStateRecord>(identity: T): T {
    return "projectId" in identity
      ? { ...identity, projectId: this.resolveProjectId(identity.projectId, identity.daemonRegistrationId) }
      : identity;
  }

  #remappedThreadAliases(mapping: ReadonlyMap<string, string>, daemonRegistrationId: string) {
    const result = new Map<string, Map<string, string>>();
    for (const [projectId, threads] of this.#threadAliases.get(daemonRegistrationId) ?? []) {
      const destination = mapping.get(projectId) ?? projectId;
      const canonical = result.get(destination) ?? new Map<string, string>();
      for (const [stored, current] of threads) {
        if (canonical.has(stored) && canonical.get(stored) !== current) throw new Error("Project adoption conflicts with retained thread identity.");
        canonical.set(stored, current);
      }
      result.set(destination, canonical);
    }
    return result;
  }

  #projectIdentity<T extends WorkbenchClientStateIdentity | WorkbenchClientStateRecord>(identity: T): T {
    identity = this.#canonicalProject(identity);
    if (identity.kind !== "composerDraft" && identity.kind !== "questionnaireDraft") return identity;
    const threadId = this.#threadAliases.get(identity.daemonRegistrationId)?.get(identity.projectId)?.get(identity.threadId);
    return threadId ? { ...identity, threadId } : identity;
  }

  #storageIdentity<T extends WorkbenchClientStateIdentity | WorkbenchClientStateRecord>(identity: T): T {
    identity = this.#canonicalProject(identity);
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
    this.#unsubscribeRpcEvent?.();
    this.#unsubscribeRpcReconnect?.();
    this.#unsubscribeRpcEvent = null;
    this.#unsubscribeRpcReconnect = null;
    this.#listeners.clear();
    this.#threadAliases.clear();
    this.#projectAliases.clear();
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
    if (this.#disposed || this.#mode === "memory" || this.#visibility.hidden() || this.#polling || this.#projectRemap) return;
    this.#cancelPendingPoll();
    this.#polling = true;
    const revisionBeforeRead = this.#revision;
    const noticeBeforeRead = this.#notifiedRevision;
    let repeat = false;
    try {
      const response = await this.#request("GET", `/api/workbench-client-state?sinceRevision=${this.#revision}`);
      if (!this.#rpc && this.#requestCapabilities === "2" && response.schemaVersion !== undefined
        && response.schemaVersion >= appStateReleases.draftImageContent.version) {
        this.#requestCapabilities = "3";
        this.#apply(await this.#request("GET", "/api/workbench-client-state"));
      } else this.#apply(response);
      if (this.#rpc && this.#notifiedRevision > this.#revision) {
        repeat = this.#revision > revisionBeforeRead || this.#notifiedRevision > noticeBeforeRead;
        if (!repeat) this.#setError("App state update is not visible yet.");
      } else this.#setError("");
    } catch (error) {
      this.#setError(error instanceof Error ? error.message : "Workbench app state polling failed.");
    } finally {
      this.#polling = false;
      if (repeat && !this.#visibility.hidden()) {
        void this.#poll();
      } else this.#schedulePoll();
    }
  }

  #schedulePoll() {
    if (this.#disposed || this.#mode === "memory" || this.#rpc || this.#visibility.hidden() || this.#scheduledPoll !== null) return;
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

  async #request(method: "DELETE" | "GET" | "PUT" | "POST", url: string, mutation?: WorkbenchClientStateMutation | WorkbenchProjectRemap) {
    const requestUrl = new URL(url, "http://workbench.local");
    if (this.#rpc) {
      const browserStateId = this.#browserStateId ?? null;
      if (method === "GET" && requestUrl.pathname === "/api/workbench-client-state") {
        const rawRevision = requestUrl.searchParams.get("sinceRevision");
        return this.#parseResponse(await this.#rpc.requestRaw({
          method: "app/state/read",
          params: { browserStateId, sinceRevision: rawRevision === null ? null : Number(rawRevision) },
        }));
      }
      if (method === "POST" && requestUrl.pathname === "/api/workbench-client-state/project-remap"
        && mutation && !("action" in mutation)) {
        return this.#parseResponse(await this.#rpc.requestRaw({
          method: "app/state/remap", params: { browserStateId, request: mutation },
        }));
      }
      if ((method === "PUT" || method === "DELETE") && mutation && "action" in mutation) {
        return this.#parseResponse(await this.#rpc.requestRaw({
          method: "app/state/mutate", params: { browserStateId, mutation },
        }));
      }
      throw new Error("Unsupported Workbench app-state RPC intent.");
    }
    const body = mutation
      ? "action" in mutation ? mutation.action === "put" ? mutation.record : mutation.identity : mutation
      : undefined;
    requestUrl.searchParams.set("capabilities", this.#requestCapabilities);
    const response = await this.#fetcher(`${requestUrl.pathname}${requestUrl.search}`, {
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
    return this.#parseResponse(await response.json());
  }

  #parseResponse(value: unknown) {
    const conformed = conformWorkbenchClientStateResponse(value);
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

  #apply(response: WorkbenchClientStateResponse, publish = true) {
    if (response.revision < this.#revision) return;
    if (this.#daemonRegistrationId !== "memory" && response.daemonRegistrationId !== this.#daemonRegistrationId) {
      throw new Error("Workbench app-state daemon registration changed during this browser session.");
    }
    this.#daemonRegistrationId = response.daemonRegistrationId;
    if (response.registrations) this.#registrations = response.registrations;
    this.#schemaVersion = response.schemaVersion ?? 0;
    this.#attachmentsAsUrls = response.attachmentsAsUrls === true;
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
    if (publish) this.#publish();
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
      attachmentsAsUrls: this.#attachmentsAsUrls,
      daemonRegistrationId: this.#daemonRegistrationId,
      error: this.#error,
      records: [...projectedRecords.values()].map((record) => this.#projectIdentity(record)),
      registrations: this.#registrations,
      revision: this.#revision,
      schemaVersion: this.#schemaVersion,
    };
    for (const listener of this.#listeners) listener();
  }
}
