/*
 * Exports:
 * - WorkbenchClientStateControllerOptions: workspace facts, browser identity and attachment transport.
 * - WorkbenchClientStateSnapshot: immutable browser projection, app-state schema capability, and visible failure.
 * - default WorkbenchClientStateController: own app-state facts, optimistic edits and browser identity.
 */
import type {
  WorkbenchClientStateIdentity,
  WorkbenchClientStateMutation,
  WorkbenchClientStateRecord,
  WorkbenchClientStateResponse,
  WorkbenchClientStateAttachmentIdentity,
  WorkbenchDaemonRegistration,
} from "workbench-shared/state/workbench-client-state";
import {
  WORKBENCH_BROWSER_STATE_HEADER,
  WorkbenchClientStateMutationSchema,
  workbenchClientStateAttachmentUrl,
} from "workbench-shared/state/workbench-client-state";
import {
  projectWorkbenchClientStateRows,
  workbenchClientStateRecordIdentity,
} from "workbench-shared/state/workbench-client-state-projection";

import { conformWorkbenchClientStateResponse } from "workbench-shared/state/workbench-client-state-conformance";
import type { WorkbenchProjectAlias } from "workbench-shared/types";
import type WorkbenchWorkspaceClient from "../app/WorkbenchWorkspaceClient";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";

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
  mode?: "workspace" | "memory";
  workspace?: WorkbenchWorkspaceClient;
}

function identityKey(identity: WorkbenchClientStateIdentity) {
  switch (identity.kind) {
    case "modelPreference": return JSON.stringify([identity.kind, identity.harness, identity.modelId]);
    case "modelGroupDisclosure": return JSON.stringify([identity.kind, identity.groupId]);
    case "globalPreference": return JSON.stringify([identity.kind, identity.key]);
    case "logicalProjectPreference": return JSON.stringify([identity.kind, identity.logicalProjectId, identity.key]);
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

export default class WorkbenchClientStateController {
  #browserStateId: string | undefined;
  readonly #workspace: WorkbenchWorkspaceClient | null;
  #observation: Pick<ReturnType<WorkbenchWorkspaceClient["observe"]>, "release"> | null = null;
  readonly #fetcher: typeof fetch;
  readonly #listeners = new Set<() => void>();
  readonly #mode: "workspace" | "memory";
  readonly #mutationQueues = new Map<string, Promise<void>>();
  readonly #optimistic = new Map<string, { generation: number; mutation: WorkbenchClientStateMutation }>();
  readonly #records = new Map<string, { record: WorkbenchClientStateRecord | null; revision: number }>();
  readonly #threadAliases = new Map<string, Map<string, Map<string, string>>>();
  readonly #projectAliases = new Map<string, Map<string, WorkbenchProjectAlias["projectId"]>>();
  #daemonRegistrationId = "memory";
  #disposed = false;
  #error = "";
  #mutationGeneration = 0;
  #revision = 0;
  #snapshotRevision = 0;
  #registrations: WorkbenchClientStateSnapshot["registrations"] = [];
  #schemaVersion = 0;
  #attachmentsAsUrls = false;
  #snapshot: WorkbenchClientStateSnapshot = {
    attachmentsAsUrls: false,
    daemonRegistrationId: "memory",
    error: "",
    records: [],
    registrations: [],
    revision: 0,
    schemaVersion: 0,
  };

  constructor(options: WorkbenchClientStateControllerOptions = {}) {
    this.#browserStateId = options.browserStateId;
    this.#workspace = options.workspace ?? null;
    this.#mode = options.mode ?? (options.workspace ? "workspace" : "memory");
    const fetcher = options.fetcher ?? globalThis.fetch;
    this.#fetcher = (input, init) => fetcher.call(globalThis, input, init);
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
    if (this.#observation) return this.#snapshot;
    if (!this.#workspace) throw new Error("App state requires the workspace connection.");
    const update = () => {
      const fact = observation.getSnapshot();
      try {
        if (fact.value?.data) this.#apply(this.#parseResponse(fact.value.data));
        this.#setError(fact.failure ?? "");
      } catch (error) {
        const message = (error instanceof Error ? error.message : "App state could not be applied.")
          .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 500);
        console.warn("Workbench app state could not be applied.", message);
        this.#setError(message);
      }
    };
    const observation = this.#workspace.observe({
      kind: "appState", browserStateId: this.#browserStateId ?? null,
    }, update);
    this.#observation = observation;
    update();
    return this.#snapshot;
  }

  bindBrowserState(browserStateId?: string) {
    if (this.#observation && this.#browserStateId !== browserStateId) throw new Error("Browser state is already bound.");
    this.#browserStateId = browserStateId;
    return this.bootstrap();
  }

  async put(record: WorkbenchClientStateRecord) {
    return await this.#mutate({ action: "put", record: this.#storageIdentity(record) });
  }

  async delete(identity: WorkbenchClientStateIdentity) {
    return await this.#mutate({ action: "delete", identity: this.#storageIdentity(identity) });
  }

  supportsAttachmentUrls() {
    return this.#attachmentsAsUrls && this.#mode === "workspace";
  }

  async uploadDraftAttachment(
    identity: WorkbenchClientStateAttachmentIdentity,
    attachmentId: string,
    sourceUrl: string,
  ) {
    if (!this.supportsAttachmentUrls()) throw new Error("App draft image uploads are unavailable.");
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

  getProjectAliases(daemonRegistrationId = this.#daemonRegistrationId): readonly WorkbenchProjectAlias[] {
    return [...(this.#projectAliases.get(daemonRegistrationId) ?? [])].map(([alias, projectId]) => ({ alias, projectId }));
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
    for (const { record } of this.#records.values()) {
      if (record && (record.kind === "composerDraft" || record.kind === "questionnaireDraft")
        && identityKey(this.#projectIdentity(record)) === key) return { ...identity, threadId: record.threadId };
    }
    return identity;
  }

  dispose() {
    this.#disposed = true;
    this.#observation?.release();
    for (const listener of this.#listeners) listener();
    this.#listeners.clear();
    this.#threadAliases.clear();
    this.#projectAliases.clear();
  }

  async #mutate(mutation: WorkbenchClientStateMutation) {
    if (this.#mode === "memory") {
      this.#revision += 1;
      if (mutation.action === "put") {
        this.#records.set(identityKey(workbenchClientStateRecordIdentity(mutation.record)), {
          record: mutation.record, revision: this.#revision,
        });
      }
      else this.#records.delete(identityKey(mutation.identity));
      this.#publish();
      return this.#snapshot;
    }
    await this.#ready();
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
        const response = await this.#request(mutation);
        this.#apply(response);
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

  #ready(): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("App state is disposed."));
    if (this.#daemonRegistrationId !== "memory") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const changed = () => {
        if (!this.#disposed && !this.#error && this.#daemonRegistrationId === "memory") return;
        this.#listeners.delete(changed);
        if (this.#disposed || this.#error) reject(new Error(this.#error || "App state is disposed."));
        else resolve();
      };
      this.#listeners.add(changed);
      changed();
    });
  }

  async #request(mutation: WorkbenchClientStateMutation) {
    if (this.#workspace) {
      const browserStateId = this.#browserStateId ?? null;
      const conformedMutation = WorkbenchClientStateMutationSchema.parse(mutation);
      return this.#parseResponse(await this.#workspace.rpc.requestRaw({
        method: "app/state/mutate", params: { browserStateId, mutation: conformedMutation },
      }));
    }
    throw new Error("App state requires the workspace connection.");
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
    if (response.revision < this.#snapshotRevision) return;
    if (this.#daemonRegistrationId !== "memory" && response.daemonRegistrationId !== this.#daemonRegistrationId) {
      throw new Error("Workbench app-state daemon registration changed during this browser session.");
    }
    if (response.revision >= this.#revision) {
      const mappings = (response.projectAliases ?? []).map(source => {
        const projects = new Map(source.aliases.map(item => [item.alias, item.projectId]));
        return { daemonRegistrationId: source.daemonRegistrationId, projects,
          threads: this.#remappedThreadAliases(projects, source.daemonRegistrationId) };
      });
      this.#daemonRegistrationId = response.daemonRegistrationId;
      if (response.registrations) this.#registrations = response.registrations;
      for (const source of mappings) {
        this.#threadAliases.set(source.daemonRegistrationId, source.threads);
        this.#projectAliases.set(source.daemonRegistrationId, source.projects);
      }
      this.#schemaVersion = response.schemaVersion ?? 0;
      this.#attachmentsAsUrls = response.attachmentsAsUrls === true;
    }
    if (response.kind === "snapshot") {
      // A full read covers absent rows too, but cannot erase a newer per-row acknowledgement.
      this.#snapshotRevision = response.revision;
      for (const [key, value] of this.#records) {
        if (value.revision <= response.revision) this.#records.delete(key);
      }
    }
    for (const change of projectWorkbenchClientStateRows(response.rows)) {
      const key = identityKey(change.change === "upsert"
        ? workbenchClientStateRecordIdentity(change.record) : change.identity);
      if (change.revision <= (this.#records.get(key)?.revision ?? -1)
        || response.kind === "delta" && change.revision <= this.#snapshotRevision) continue;
      this.#records.set(key, {
        record: change.change === "upsert" ? change.record : null, revision: change.revision,
      });
    }
    this.#revision = Math.max(this.#revision, response.revision);
    if (publish) this.#publish();
  }

  #setError(error: string) {
    if (this.#error === error) return;
    this.#error = error;
    this.#publish();
  }

  #publish() {
    const projectedRecords = new Map([...this.#records].flatMap(([key, value]) =>
      value.record ? [[key, value.record] as const] : []));
    for (const [key, { mutation }] of this.#optimistic) {
      if (mutation.action === "put") projectedRecords.set(key, mutation.record);
      else projectedRecords.delete(key);
    }
    const next: WorkbenchClientStateSnapshot = {
      attachmentsAsUrls: this.#attachmentsAsUrls,
      daemonRegistrationId: this.#daemonRegistrationId,
      error: this.#error,
      records: [...projectedRecords.values()].map((record) => this.#projectIdentity(record)),
      registrations: this.#registrations,
      revision: this.#revision,
      schemaVersion: this.#schemaVersion,
    };
    if (areDeeplyEqual(this.#snapshot, next)) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}
