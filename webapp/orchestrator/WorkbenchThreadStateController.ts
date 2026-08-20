/*
 * Exports:
 * - WorkbenchThreadStateControllerOptions/WorkbenchThreadReconciliationFailure/WorkbenchObservedLifecycleEvent: catalog, project-state ports, progressive reconciliation, and identity-owned provider lifecycle input. Keywords: ownership, reconciliation, notification.
 * - default WorkbenchThreadStateController: own the shared project observer set, durable thread metadata, and pushed sidebar lifecycle. Keywords: drafts, project, lifecycle, observation.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { WorkbenchProjectsPayload } from "../lib/types";
import { areDeeplyEqual } from "../lib/workbench/deep-equality";
import { WorkbenchProjectStateRequestSchema, type WorkbenchProjectStateRequest, type WorkbenchProjectStateUpdate } from "../lib/workbench/project/project-state";
import {
  WorkbenchThreadDraftSchema,
  WorkbenchThreadLifecycleSchema,
  WorkbenchThreadSidebarEntrySchema,
  WorkbenchThreadStateRequestSchema,
  getWorkbenchLifecycleTurnId,
  getThreadSidebarGroup,
  isWorkbenchThreadStatusProviderOwned,
  projectWorkbenchThreadSidebarEntries,
  reduceWorkbenchThreadLifecycle,
  sortThreadSidebarEntries,
  type WorkbenchLifecycleEvent,
  type WorkbenchThreadLifecycle,
  type WorkbenchThreadDraft,
  type WorkbenchGitArcLifecycleState,
  type WorkbenchHarnessId,
  type WorkbenchThreadActivityUpdate,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadSidebarSnapshot,
  type WorkbenchThreadStateOpenResult,
  type WorkbenchThreadStateRequest,
  type WorkbenchThreadStateSnapshot,
} from "../lib/workbench/thread/thread-state";
import AtomicJsonStore from "./AtomicJsonStore";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";

interface StoredThreadMetadata { archived: boolean; harness: "codex" | "copilot" | "opencode"; lifecycle: WorkbenchThreadLifecycle; pinned: boolean; snoozed: boolean; threadId: string; titleFallback?: string }
type StoredThreadDraft = WorkbenchThreadDraft & { pinned?: boolean; snoozed?: boolean };
interface StoredProjectStateV1 { drafts: StoredThreadDraft[]; threads: StoredThreadMetadata[]; version: 1 }
interface StoredProjectState { drafts: StoredThreadDraft[]; threads: StoredThreadMetadata[]; version: 2 }
type LegacyGitArcClaim = Omit<WorkbenchGitArcLifecycleState, "phase" | "proposals"> & { proposalId?: string | null; proposalStatus?: "committed" | "proposed" | null };

function normalizeResolvedGitArc(value: WorkbenchGitArcLifecycleState | LegacyGitArcClaim | null) {
  if (!value) return null;
  if ("phase" in value) return value;
  return {
    checkpointCommit: value.checkpointCommit,
    claimedPaths: value.claimedPaths,
    intentDescription: value.intentDescription,
    intentName: value.intentName,
    phase: "active" as const,
    proposals: value.proposalId && value.proposalStatus
      ? [{ proposalId: value.proposalId, status: value.proposalStatus }]
      : [],
    updatedAt: value.updatedAt,
  };
}

export interface WorkbenchThreadStateControllerOptions {
  getProjectCatalog: () => WorkbenchProjectsPayload;
  log?: (message: string) => void;
  now?: () => number;
  projectState: {
    getCurrentUpdate: (projectId: string) => WorkbenchProjectStateUpdate | null;
    handleRequest: (projectId: string, request: WorkbenchProjectStateRequest) => Promise<unknown>;
    observe: (projectId: string, publish: (update: WorkbenchProjectStateUpdate) => void) => () => void;
  };
  publish: (connectionId: string, snapshot: WorkbenchThreadStateSnapshot) => void;
  reconcileProject: (
    projectId: string,
    signal: AbortSignal,
    acceptProviderSnapshot: (harness: WorkbenchHarnessId, entries: WorkbenchThreadSidebarEntry[], options: { complete: boolean }) => void,
  ) => Promise<WorkbenchThreadReconciliationFailure[]>;
  resolveGitArc: (projectId: string, harness: WorkbenchHarnessId, threadId: string) => Promise<WorkbenchGitArcLifecycleState | LegacyGitArcClaim | null>;
  resolveProjectRoot: (projectId: string) => Promise<string>;
  runGitArcTransition: <TValue>(projectId: string, operation: () => Promise<TValue>) => Promise<TValue>;
  storageRoot: string;
}

export interface WorkbenchThreadReconciliationFailure {
  harness: WorkbenchHarnessId;
  message: string;
}

export interface WorkbenchThreadClaimContext {
  lifecycle: WorkbenchThreadLifecycle;
  title: string;
}

export type WorkbenchObservedLifecycleEvent =
  | Exclude<WorkbenchLifecycleEvent, { kind: "inputResolved" | "pendingInput" }>
  | { kind: "inputResolved"; requestKey: string }
  | { kind: "pendingInput"; requestKey: string; turnId: string | null };

interface ProjectState {
  abort: AbortController | null;
  drafts: Map<string, WorkbenchThreadDraft>;
  entries: Map<string, WorkbenchThreadSidebarEntry>;
  error: string | null;
  freshness: WorkbenchThreadSidebarSnapshot["freshness"];
  generation: number;
  observers: Set<string>;
  overlays: Map<string, StoredThreadMetadata>;
  reconcilePromise: Promise<void> | null;
  revision: number;
  stopProjectObservation: (() => void) | null;
}

function entryKey(entry: WorkbenchThreadSidebarEntry) {
  if (entry.entryKind === "draft") return `draft:${entry.draft.draftId}`;
  return `${entry.identity.harness}:${entry.identity.threadId}`;
}

function parseStoredDraft(candidate: unknown) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const { pinned, snoozed, ...draftCandidate } = candidate as Record<string, unknown>;
  const draft = WorkbenchThreadDraftSchema.safeParse(draftCandidate);
  return draft.success
    ? { draft: draft.data, metadata: { archived: false as const, pinned: pinned === true, snoozed: snoozed === true } }
    : null;
}

function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
}

function sanitizeLogValue(value: unknown) {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9_./:-]/gu, "?").slice(0, 160);
}

function describeRequestField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value === "string") return `${key}=string(${value.length})`;
  if (value === null) return `${key}=null`;
  if (Array.isArray(value)) return `${key}=array(${value.length})`;
  return `${key}=${typeof value}`;
}

function describeInvalidRequest(input: object, issue: { code: string; message: string; path: PropertyKey[] }) {
  const record = input as Record<string, unknown>;
  const identity = record.identity && typeof record.identity === "object" && !Array.isArray(record.identity)
    ? record.identity as Record<string, unknown>
    : {};
  const path = issue.path.length ? issue.path.map(sanitizeLogValue).join(".") : "root";
  return [
    `issueCode=${sanitizeLogValue(issue.code)}`,
    `issuePath=${path}`,
    `issueMessage=${sanitizeError(issue.message)}`,
    `keys=${Object.keys(record).sort().map(sanitizeLogValue).join(",") || "none"}`,
    `fields=${["projectId", "title", "turnId"].map((key) => describeRequestField(record, key)).join(",")}`,
    `identityKeys=${Object.keys(identity).sort().map(sanitizeLogValue).join(",") || "none"}`,
    `identityFields=${["harness", "threadId"].map((key) => describeRequestField(identity, key)).join(",")}`,
  ].join(" ");
}

export default class WorkbenchThreadStateController {
  private active = true;
  private readonly connectionProjects = new Map<string, string>();
  private readonly json = new AtomicJsonStore();
  private readonly now: () => number;
  private readonly options: WorkbenchThreadStateControllerOptions;
  private readonly projects = new Map<string, ProjectState>();
  private readonly operationQueues = new Map<string, Promise<unknown>>();
  private readonly reconciliationPromises = new Set<Promise<void>>();
  private readonly subscribers = new Set<(projectId: string, entry: WorkbenchThreadSidebarEntry) => void>();

  constructor(options: WorkbenchThreadStateControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async handleRequest(connectionId: string, input: WorkbenchThreadStateRequest | object) {
    const startedAt = this.now();
    const method = sanitizeLogValue((input as { method?: unknown }).method);
    const safeConnectionId = sanitizeLogValue(connectionId);
    this.options.log?.(`request started connection=${safeConnectionId} method=${method}`);
    try {
      const response = await this.handleRequestOwned(connectionId, input);
      const outcome = "error" in response ? `error code=${sanitizeLogValue(response.error.code)}` : "success";
      this.options.log?.(`request completed connection=${safeConnectionId} method=${method} outcome=${outcome} elapsedMs=${Math.max(0, this.now() - startedAt)}`);
      return response;
    } catch (error) {
      this.options.log?.(`request completed connection=${safeConnectionId} method=${method} outcome=exception elapsedMs=${Math.max(0, this.now() - startedAt)}`);
      throw error;
    }
  }

  private async handleRequestOwned(connectionId: string, input: WorkbenchThreadStateRequest | object) {
    const projectRequest = WorkbenchProjectStateRequestSchema.safeParse(input);
    if (projectRequest.success) {
      const observedProjectId = this.connectionProjects.get(connectionId);
      if (observedProjectId !== projectRequest.data.projectId) {
        return { error: { code: "invalidProjectObservation", message: "The project request does not belong to this connection's observed project." } };
      }
      try {
        return { result: await this.options.projectState.handleRequest(observedProjectId, projectRequest.data) };
      } catch (error) {
        return { error: { code: "projectStateRequestFailed", message: sanitizeError(error) } };
      }
    }
    const parsed = WorkbenchThreadStateRequestSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue) this.options.log?.(`request invalid method=${sanitizeLogValue((input as { method?: unknown }).method)} ${describeInvalidRequest(input, issue)}`);
      return { error: { code: "invalidThreadStateMutation", message: issue?.message ?? "Invalid thread-state request." } };
    }
    const request = parsed.data;
    switch (request.method) {
      case "workbench/thread-state/open": return { result: await this.open(connectionId, request.projectId, request.version ?? 1) };
      case "workbench/thread-state/close": await this.close(connectionId, request.projectId); return { result: { accepted: true } };
      case "workbench/thread-state/refresh": return { result: await this.refresh(request.projectId) };
      case "workbench/thread-state/intent/accept": return { result: await this.acceptIntent(connectionId, {
        draftId: request.draftId,
        harness: request.identity.harness,
        projectId: request.projectId,
        threadId: request.identity.threadId,
        title: request.title,
        turnId: request.turnId,
      }) };
      case "workbench/thread-state/draft/upsert": return { result: await this.upsertDraft(request.projectId, request.draft) };
      case "workbench/thread-state/draft/delete": return { result: await this.deleteDraft(request.projectId, request.draftId, request.clientUpdatedAt) };
      case "workbench/thread-state/draft/pin/set":
      case "workbench/thread-state/draft/snooze/set": return { result: await this.mutateDraft(request) };
      default: return { result: await this.mutateThread(request) };
    }
  }

  async open(connectionId: string, projectId: string): Promise<WorkbenchThreadStateOpenResult>;
  async open(connectionId: string, projectId: string, version: 2): Promise<WorkbenchThreadStateOpenResult>;
  async open(connectionId: string, projectId: string, version: 1): Promise<WorkbenchThreadSidebarSnapshot>;
  async open(connectionId: string, projectId: string, version: 1 | 2): Promise<WorkbenchThreadSidebarSnapshot | WorkbenchThreadStateOpenResult>;
  async open(connectionId: string, projectId: string, version: 1 | 2 = 2): Promise<WorkbenchThreadSidebarSnapshot | WorkbenchThreadStateOpenResult> {
    const priorProjectId = this.connectionProjects.get(connectionId);
    if (priorProjectId && priorProjectId !== projectId) await this.close(connectionId, priorProjectId);
    const state = await this.getProject(projectId);
    this.connectionProjects.set(connectionId, projectId);
    const wasUnobserved = state.observers.size === 0;
    state.observers.add(connectionId);
    let currentProjectUpdate: WorkbenchProjectStateUpdate | null = null;
    if (wasUnobserved) {
      state.stopProjectObservation = this.options.projectState.observe(projectId, (update) => this.publishUpdate(state, update));
      setTimeout(() => {
        if (this.active && state.observers.size) void this.reconcile(projectId, state);
      }, 0);
    } else {
      currentProjectUpdate = this.options.projectState.getCurrentUpdate(projectId);
      if (currentProjectUpdate) {
        this.options.publish(connectionId, currentProjectUpdate);
        this.options.log?.(`project replayed connection=${sanitizeLogValue(connectionId)} project=${sanitizeLogValue(projectId)} revision=${currentProjectUpdate.revision}`);
      }
    }
    const sidebar = this.snapshot(projectId, state);
    if (version === 1) return sidebar;
    return {
      catalog: this.options.getProjectCatalog(),
      project: currentProjectUpdate ?? this.options.projectState.getCurrentUpdate(projectId),
      sidebar,
    };
  }

  async close(connectionId: string, expectedProjectId?: string) {
    const projectId = this.connectionProjects.get(connectionId);
    if (!projectId || (expectedProjectId && projectId !== expectedProjectId)) return;
    this.connectionProjects.delete(connectionId);
    const state = this.projects.get(projectId);
    if (!state) return;
    state.observers.delete(connectionId);
    if (!state.observers.size) {
      state.generation += 1;
      state.abort?.abort();
      state.abort = null;
      state.reconcilePromise = null;
      state.stopProjectObservation?.();
      state.stopProjectObservation = null;
    }
  }

  async disconnect(connectionId: string) { await this.close(connectionId); }

  async acceptIntent(connectionId: string, input: { draftId?: string; harness: "codex" | "copilot" | "opencode"; projectId: string; threadId: string; title?: string; turnId: string }) {
    if (this.connectionProjects.get(connectionId) !== input.projectId) throw new Error("The accepted intent does not belong to this connection's observed project.");
    let draftPinned = false;
    if (input.draftId) {
      const state = await this.getProject(input.projectId);
      const draftEntry = state.entries.get(`draft:${input.draftId}`);
      draftPinned = draftEntry?.entryKind === "draft" ? draftEntry.metadata.pinned : false;
      state.drafts.delete(input.draftId);
      state.entries.delete(`draft:${input.draftId}`);
    }
    const providerEntry: WorkbenchThreadSidebarEntry = {
      activityAt: this.now(), entryKind: "thread", identity: { harness: input.harness, threadId: input.threadId },
      lifecycle: { agent: { agentStatus: "working", turnId: input.turnId }, kind: "working", reason: "acceptedIntent", settled: false },
      metadata: { archived: false, pinned: draftPinned, snoozed: false }, title: input.title?.trim() || input.threadId,
    };
    const entry = await this.applyLifecycle(input.projectId, input.harness, input.threadId, { kind: "acceptedIntent", turnId: input.turnId }, providerEntry);
    if (!entry) throw new Error("The accepted intent does not identify a known provider thread.");
    return { accepted: true, revision: (await this.getSnapshot(input.projectId)).revision };
  }

  async reportRecoveryFailed(projectId: string, harness: "codex" | "copilot" | "opencode", threadId: string) {
    return await this.applyLifecycle(projectId, harness, threadId, { kind: "recoveryFailed" });
  }

  async refresh(projectId: string) {
    const state = await this.getProject(projectId);
    if (state.observers.size) void this.reconcile(projectId, state);
    return this.snapshot(projectId, state);
  }

  async applyLifecycle(projectId: string, harness: "codex" | "copilot" | "opencode", threadId: string, event: WorkbenchLifecycleEvent, providerEntry?: WorkbenchThreadSidebarEntry) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const activeBefore = this.countActiveQueueEntries(state);
      if (!state.entries.has(key) && providerEntry?.entryKind === "thread" && entryKey(providerEntry) === key) state.entries.set(key, providerEntry);
      const existing = state.entries.get(key);
      if (!existing || existing.entryKind === "draft") return null;
      const ownedEvent = existing.entryKind === "subagent" && event.kind === "turnCompleted" && event.status === "completed"
        ? { kind: "agentStatus" as const, status: "completed" as const, turnId: event.turnId }
        : event;
      const lifecycle = reduceWorkbenchThreadLifecycle(existing.lifecycle, ownedEvent);
      const shouldUnsnooze = existing.entryKind === "thread" && existing.metadata.snoozed && existing.lifecycle.kind === "working" && (lifecycle.kind === "needsAttention" || lifecycle.kind === "completed" || lifecycle.kind === "stopped");
      const next = existing.entryKind === "subagent"
        ? { ...existing, activityAt: this.now(), lifecycle }
        : {
          ...existing,
          activityAt: this.now(),
          lifecycle,
          metadata: existing.metadata.archived
            ? { archived: true as const, pinned: false as const, snoozed: false as const }
            : { ...existing.metadata, snoozed: shouldUnsnooze ? false : existing.metadata.snoozed },
        };
      const parsedNext = WorkbenchThreadSidebarEntrySchema.parse(next);
      if (parsedNext.entryKind === "draft") throw new Error("Lifecycle transitions cannot produce draft entries.");
      state.entries.set(key, parsedNext);
      state.overlays.set(key, this.overlayFromEntry(parsedNext));
      if (activeBefore > 0 && this.countActiveQueueEntries(state) === 0) {
        for (const [candidateKey, candidate] of state.entries) {
          if (candidate.entryKind !== "subagent" && !candidate.metadata.archived && candidate.metadata.snoozed) {
            state.entries.set(candidateKey, WorkbenchThreadSidebarEntrySchema.parse({ ...candidate, metadata: { ...candidate.metadata, snoozed: false } }));
          }
        }
      }
      await this.persist(projectId, state);
      this.publish(projectId, state, parsedNext);
      return parsedNext;
    });
  }

  async observeLifecycle(harness: "codex" | "copilot" | "opencode", threadId: string, event: WorkbenchObservedLifecycleEvent) {
    const key = `${harness}:${threadId}`;
    const projectIds = [...this.projects.entries()].filter(([, state]) => state.entries.has(key)).map(([projectId]) => projectId);
    for (const projectId of projectIds) {
      const entry = this.projects.get(projectId)?.entries.get(key);
      if (!entry || entry.entryKind === "draft") continue;
      let exactEvent: WorkbenchLifecycleEvent | null = event as WorkbenchLifecycleEvent;
      if (event.kind === "pendingInput") {
        const turnId = event.turnId ?? getWorkbenchLifecycleTurnId(entry.lifecycle);
        exactEvent = turnId ? { kind: "pendingInput", requestKey: event.requestKey, turnId } : null;
      } else if (event.kind === "inputResolved") {
        exactEvent = entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput" && entry.lifecycle.requestKey === event.requestKey
          ? { kind: "inputResolved", requestKey: event.requestKey, turnId: entry.lifecycle.turnId }
          : null;
      }
      if (exactEvent) await this.applyLifecycle(projectId, harness, threadId, exactEvent);
    }
  }

  async observeActivity(harness: "codex" | "copilot" | "opencode", threadId: string) {
    const key = `${harness}:${threadId}`;
    for (const [projectId, state] of this.projects) {
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") continue;
      const next = WorkbenchThreadSidebarEntrySchema.parse({ ...entry, activityAt: this.now() });
      if (next.entryKind === "draft") continue;
      state.entries.set(key, next);
      if (!this.active || !state.observers.size) continue;
      state.revision += 1;
      this.publishUpdate(state, {
        activityAt: next.activityAt,
        identity: next.identity,
        projectId,
        revision: state.revision,
        updateKind: "activity",
      } satisfies WorkbenchThreadActivityUpdate);
    }
  }

  async observeTitle(harness: "codex" | "copilot" | "opencode", threadId: string, title: string) {
    const key = `${harness}:${threadId}`;
    for (const [projectId, state] of this.projects) {
      if (state.entries.has(key)) await this.setTitle(projectId, harness, threadId, title);
    }
  }

  async setTitle(projectId: string, harness: "codex" | "copilot" | "opencode", threadId: string, title: string) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") return null;
      const next = WorkbenchThreadSidebarEntrySchema.parse({ ...entry, title });
      if (next.entryKind === "draft") return null;
      if (areDeeplyEqual(entry, next)) return next;
      state.entries.set(key, next);
      state.overlays.set(key, this.overlayFromEntry(next));
      await this.persist(projectId, state);
      this.publish(projectId, state, next);
      return next;
    });
  }

  async getSnapshot(projectId: string) {
    const state = await this.getProject(projectId);
    return this.snapshot(projectId, state);
  }

  async getThreadClaimContext(projectId: string, harness: WorkbenchHarnessId, threadId: string): Promise<WorkbenchThreadClaimContext | null> {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    const entry = state.entries.get(key);
    const stored = await this.loadProjectStorage(projectId);
    const storedEntry = stored.threads.find((candidate) => candidate.harness === harness && candidate.threadId === threadId);
    const storedLifecycle = WorkbenchThreadLifecycleSchema.safeParse(storedEntry?.lifecycle);
    const lifecycle = storedLifecycle.success
      ? storedLifecycle.data
      : entry && entry.entryKind !== "draft" ? entry.lifecycle : null;
    if (!lifecycle) return null;
    return {
      lifecycle,
      title: entry?.title ?? storedEntry?.titleFallback?.trim() ?? threadId,
    };
  }

  async refreshFileClaim(projectId: string, harness: WorkbenchHarnessId, threadId: string) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") return null;
      const gitArc = normalizeResolvedGitArc(await this.options.resolveGitArc(projectId, harness, threadId));
      const next = WorkbenchThreadSidebarEntrySchema.parse({ ...entry, gitArc });
      if (next.entryKind === "draft") return null;
      if (areDeeplyEqual(entry, next)) return next;
      state.entries.set(key, next);
      this.publish(projectId, state, next);
      return next;
    });
  }

  async dispose() {
    this.active = false;
    for (const state of this.projects.values()) {
      state.generation += 1;
      state.abort?.abort();
      state.stopProjectObservation?.();
      state.stopProjectObservation = null;
    }
    await Promise.allSettled(this.operationQueues.values());
    await this.json.waitForIdle();
  }

  private async getProject(projectId: string) {
    const current = this.projects.get(projectId);
    if (current) return current;
    await this.enqueue(`${projectId}:project:load`, async () => {
      if (this.projects.has(projectId)) return;
      const stored = await this.loadProjectStorage(projectId);
      const drafts = new Map<string, WorkbenchThreadDraft>();
      const entries = new Map<string, WorkbenchThreadSidebarEntry>();
      for (const candidate of Array.isArray(stored.drafts) ? stored.drafts : []) {
        const parsed = parseStoredDraft(candidate);
        if (!parsed || parsed.draft.projectId !== projectId) continue;
        drafts.set(parsed.draft.draftId, parsed.draft);
        entries.set(`draft:${parsed.draft.draftId}`, this.draftEntry(parsed.draft, parsed.metadata));
      }
      const overlays = new Map<string, StoredThreadMetadata>();
      for (const candidate of Array.isArray(stored.threads) ? stored.threads : []) {
        if (!candidate || typeof candidate !== "object") continue;
        const lifecycle = WorkbenchThreadLifecycleSchema.safeParse(candidate.lifecycle);
        if (!lifecycle.success || !candidate.threadId || !candidate.harness) continue;
        if (candidate.harness !== "codex" && candidate.harness !== "copilot" && candidate.harness !== "opencode") continue;
        const overlay: StoredThreadMetadata = {
          archived: Boolean(candidate.archived),
          harness: candidate.harness,
          lifecycle: lifecycle.data,
          pinned: candidate.archived ? false : Boolean(candidate.pinned),
          snoozed: candidate.archived ? false : Boolean(candidate.snoozed),
          threadId: String(candidate.threadId),
          ...(typeof candidate.titleFallback === "string" && candidate.titleFallback.trim() ? { titleFallback: candidate.titleFallback.trim() } : {}),
        };
        overlays.set(`${overlay.harness}:${overlay.threadId}`, overlay);
      }
      const state: ProjectState = { abort: null, drafts, entries, error: null, freshness: "loading", generation: 0, observers: new Set(), overlays, reconcilePromise: null, revision: 0, stopProjectObservation: null };
      this.projects.set(projectId, state);
    });
    const loaded = this.projects.get(projectId);
    if (!loaded) throw new Error(`Project state failed to load: ${projectId}`);
    return loaded;
  }

  private loadProjectStorage(projectId: string) {
    return this.enqueue(`${projectId}:storage:migrate`, async (): Promise<StoredProjectState> => {
      const canonicalPath = this.filePath(projectId);
      const canonicalExists = await this.fileExists(canonicalPath);
      if (canonicalExists) {
        const stored = await this.json.read<StoredProjectState | StoredProjectStateV1>(canonicalPath, { drafts: [], threads: [], version: 2 });
        const canonical = this.toStoredProjectState(stored);
        if (stored.version !== 2) await this.json.write(canonicalPath, canonical);
        return canonical;
      }

      const projectRoot = await this.options.resolveProjectRoot(projectId);
      const legacyPath = this.legacyFilePath(projectRoot, projectId);
      if (!await this.fileExists(legacyPath)) return { drafts: [], threads: [], version: 2 };
      const legacy = await this.json.read<StoredProjectStateV1>(legacyPath, { drafts: [], threads: [], version: 1 });
      const canonical = this.toStoredProjectState(legacy);
      await this.json.write(canonicalPath, canonical);
      return canonical;
    });
  }

  private toStoredProjectState(stored: Partial<StoredProjectState | StoredProjectStateV1>): StoredProjectState {
    return {
      drafts: Array.isArray(stored.drafts) ? stored.drafts : [],
      threads: Array.isArray(stored.threads) ? stored.threads : [],
      version: 2,
    };
  }

  private async fileExists(filePath: string) {
    try {
      return (await fs.stat(filePath)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }
  }

  private filePath(projectId: string) { return path.join(this.options.storageRoot, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment(projectId)}.json`); }
  private legacyFilePath(projectRoot: string, projectId: string) { return path.join(projectRoot, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment(projectId)}.json`); }
  private draftEntry(draft: WorkbenchThreadDraft, metadata = { archived: false as const, pinned: false, snoozed: false }): WorkbenchThreadSidebarEntry { return { activityAt: draft.updatedAt, draft, entryKind: "draft", metadata, title: draft.prompt.trim().split(/\r?\n/u).find(Boolean)?.trim().replace(/\s+/gu, " ") || "Draft" }; }
  private snapshot(projectId: string, state: ProjectState): WorkbenchThreadSidebarSnapshot { return { entries: sortThreadSidebarEntries(projectWorkbenchThreadSidebarEntries([...state.entries.values()])).filter((entry) => getThreadSidebarGroup(entry) !== "hidden"), error: state.error, freshness: state.freshness, projectId, revision: state.revision }; }
  private countActiveQueueEntries(state: ProjectState) { return [...state.entries.values()].filter((entry) => { const group = getThreadSidebarGroup(entry); return group === "drafts" || group === "needsAttention" || group === "completed" || group === "working"; }).length; }

  private publish(projectId: string, state: ProjectState, changedEntry?: WorkbenchThreadSidebarEntry) {
    if (!this.active || !state.observers.size) return;
    state.revision += 1;
    const snapshot = this.snapshot(projectId, state);
    this.publishUpdate(state, snapshot);
    if (changedEntry) for (const listener of this.subscribers) listener(projectId, changedEntry);
  }

  private publishUpdate(state: ProjectState, update: WorkbenchThreadStateSnapshot) {
    if (!this.active) return;
    for (const connectionId of state.observers) this.options.publish(connectionId, update);
  }

  private reconcile(projectId: string, state: ProjectState) {
    if (state.reconcilePromise) return state.reconcilePromise;
    const generation = ++state.generation;
    const abort = new AbortController();
    state.abort?.abort();
    state.abort = abort;
    const reconcilePromise = this.options.reconcileProject(projectId, abort.signal, (harness, entries, options) => {
      if (!this.active || generation !== state.generation || !state.observers.size) return;
      this.installProviderSnapshot(state, harness, entries, options);
      state.error = null;
      state.freshness = "partial";
      this.publish(projectId, state);
    }).then((failures) => {
      if (!this.active || generation !== state.generation || !state.observers.size) return;
      state.error = failures.length
        ? failures.map((failure) => `${failure.harness}: ${sanitizeError(failure.message)}`).join("; ").slice(0, 500)
        : null;
      state.freshness = failures.length ? "partial" : "fresh";
      this.publish(projectId, state);
    }, (error) => {
      if (generation !== state.generation || abort.signal.aborted) return;
      state.error = sanitizeError(error);
      state.freshness = "partial";
      this.publish(projectId, state);
    }).finally(() => {
      this.reconciliationPromises.delete(reconcilePromise);
      if (state.reconcilePromise === reconcilePromise) state.reconcilePromise = null;
      if (state.abort === abort) state.abort = null;
    });
    state.reconcilePromise = reconcilePromise;
    this.reconciliationPromises.add(reconcilePromise);
    return reconcilePromise;
  }

  private installProviderSnapshot(
    state: ProjectState,
    harness: WorkbenchHarnessId,
    entries: WorkbenchThreadSidebarEntry[],
    { complete }: { complete: boolean },
  ) {
    const providerKeys = new Set<string>();
    for (const candidate of entries) {
      const parsed = WorkbenchThreadSidebarEntrySchema.safeParse(candidate);
      if (!parsed.success || parsed.data.entryKind === "draft" || parsed.data.identity.harness !== harness) continue;
      const key = entryKey(parsed.data);
      providerKeys.add(key);
      const overlay = state.overlays.get(key);
      if (parsed.data.entryKind === "subagent") {
        const lifecycle = overlay?.lifecycle ?? parsed.data.lifecycle;
        state.entries.set(key, overlay ? {
          ...parsed.data,
          lifecycle: parsed.data.gitArc?.claimedPaths.length && lifecycle.settled ? { ...lifecycle, settled: false as const } : lifecycle,
          pinned: overlay.pinned,
        } : parsed.data);
        continue;
      }
      const metadata = overlay?.archived
        ? { archived: true as const, pinned: false as const, snoozed: false as const }
        : { archived: false as const, pinned: overlay?.pinned ?? parsed.data.metadata.pinned, snoozed: overlay?.snoozed ?? parsed.data.metadata.snoozed };
      state.entries.set(key, overlay ? {
        ...parsed.data,
        lifecycle: parsed.data.gitArc?.claimedPaths.length && overlay.lifecycle.settled
          ? { ...overlay.lifecycle, settled: false as const }
          : overlay.lifecycle,
        metadata,
        title: parsed.data.title === "New thread" && overlay.titleFallback ? overlay.titleFallback : parsed.data.title,
      } : parsed.data);
    }
    if (!complete) return;
    for (const [key, entry] of state.entries) {
      const isAcceptedIntentAwaitingProvider = entry.entryKind !== "draft"
        && entry.lifecycle.kind === "working"
        && entry.lifecycle.reason === "acceptedIntent";
      if (entry.entryKind !== "draft" && entry.identity.harness === harness && !providerKeys.has(key) && !isAcceptedIntentAwaitingProvider) {
        state.entries.delete(key);
      }
    }
  }

  private enqueue<TValue>(key: string, operation: () => Promise<TValue>) {
    const previous = this.operationQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operationQueues.set(key, next);
    return next.finally(() => { if (this.operationQueues.get(key) === next) this.operationQueues.delete(key); });
  }

  private async upsertDraft(projectId: string, draft: WorkbenchThreadDraft) {
    const state = await this.getProject(projectId);
    await this.enqueue(`${projectId}:draft:${draft.draftId}`, async () => {
      const current = state.drafts.get(draft.draftId);
      if (current && current.clientUpdatedAt > draft.clientUpdatedAt) return;
      const timestamp = this.now();
      const accepted = WorkbenchThreadDraftSchema.parse({ ...draft, createdAt: current?.createdAt ?? timestamp, projectId, updatedAt: timestamp });
      state.drafts.set(accepted.draftId, accepted);
      const existingEntry = state.entries.get(`draft:${accepted.draftId}`);
      const entry = this.draftEntry(accepted, existingEntry?.entryKind === "draft" ? existingEntry.metadata : undefined);
      state.entries.set(entryKey(entry), entry);
      await this.persist(projectId, state);
      this.publish(projectId, state, entry);
    });
    return { accepted: true, revision: state.revision };
  }

  private async deleteDraft(projectId: string, draftId: string, clientUpdatedAt: number) {
    const state = await this.getProject(projectId);
    await this.enqueue(`${projectId}:draft:${draftId}`, async () => {
      const current = state.drafts.get(draftId);
      if (current && current.clientUpdatedAt > clientUpdatedAt) return;
      state.drafts.delete(draftId); state.entries.delete(`draft:${draftId}`);
      await this.persist(projectId, state); this.publish(projectId, state);
    });
    return { accepted: true, revision: state.revision };
  }

  private async mutateDraft(request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/draft/pin/set" | "workbench/thread-state/draft/snooze/set" }>) {
    const state = await this.getProject(request.projectId);
    return await this.enqueue(`${request.projectId}:draft:${request.draftId}`, async () => {
      const key = `draft:${request.draftId}`;
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind !== "draft") return { accepted: false, revision: state.revision };
      const next = WorkbenchThreadSidebarEntrySchema.parse({
        ...entry,
        metadata: request.method === "workbench/thread-state/draft/pin/set"
          ? { ...entry.metadata, pinned: request.pinned }
          : { ...entry.metadata, snoozed: request.snoozed },
      });
      if (areDeeplyEqual(entry, next)) return { accepted: true, revision: state.revision };
      state.entries.set(key, next);
      await this.persist(request.projectId, state);
      this.publish(request.projectId, state, next);
      return { accepted: true, revision: state.revision };
    });
  }

  private async mutateThread(request: Exclude<WorkbenchThreadStateRequest, { method: "workbench/thread-state/open" | "workbench/thread-state/close" | "workbench/thread-state/refresh" | "workbench/thread-state/draft/upsert" | "workbench/thread-state/draft/delete" | "workbench/thread-state/draft/pin/set" | "workbench/thread-state/draft/snooze/set" }>) {
    const state = await this.getProject(request.projectId);
    const key = `${request.identity.harness}:${request.identity.threadId}`;
    const mutate = async () => await this.enqueue(`${request.projectId}:thread:${key}`, async () => {
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") return { accepted: false, revision: state.revision };
      if (request.method === "workbench/thread-state/status/set" && (
        entry.entryKind !== "thread"
        || entry.metadata.archived
        || isWorkbenchThreadStatusProviderOwned(entry.lifecycle)
      )) {
        return { accepted: false, revision: state.revision };
      }
      const canSettle = entry.lifecycle.kind === "completed"
        || entry.lifecycle.kind === "stopped"
        || (entry.entryKind === "thread" && entry.lifecycle.kind === "needsAttention" && !isWorkbenchThreadStatusProviderOwned(entry.lifecycle));
      if (request.method === "workbench/thread-state/settle" && !canSettle) {
        return { accepted: false, revision: state.revision };
      }
      if (
        request.method === "workbench/thread-state/settle"
        && normalizeResolvedGitArc(await this.options.resolveGitArc(request.projectId, entry.identity.harness, entry.identity.threadId))?.claimedPaths.length
      ) {
        return { accepted: false, revision: state.revision };
      }
      let next = entry;
      if (request.method === "workbench/thread-state/pin/set") next = entry.entryKind === "subagent"
        ? { ...entry, pinned: request.pinned }
        : entry.metadata.archived
          ? entry
          : { ...entry, metadata: { archived: false as const, pinned: request.pinned, snoozed: entry.metadata.snoozed } };
      if (entry.entryKind === "thread" && !entry.metadata.archived && request.method === "workbench/thread-state/snooze/set" && !(entry.lifecycle.settled && request.snoozed)) next = { ...entry, metadata: { archived: false, pinned: entry.metadata.pinned, snoozed: request.snoozed } };
      if (request.method === "workbench/thread-state/settle") {
        const lifecycle = reduceWorkbenchThreadLifecycle(entry.lifecycle, { kind: "settle" });
        next = entry.entryKind === "subagent"
          ? { ...entry, lifecycle, pinned: false }
          : { ...entry, lifecycle, metadata: entry.metadata.archived ? entry.metadata : { ...entry.metadata, snoozed: false } };
      }
      if (request.method === "workbench/thread-state/restore" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped")) next = { ...entry, lifecycle: reduceWorkbenchThreadLifecycle(entry.lifecycle, { kind: "restore" }) };
      if (entry.entryKind === "thread" && request.method === "workbench/thread-state/status/set" && entry.lifecycle.kind !== request.status) {
        const lifecycle = reduceWorkbenchThreadLifecycle(
          entry.lifecycle,
          request.status === "needsAttention"
            ? { kind: "userNeedsAttention" }
            : request.status === "stopped"
              ? { kind: "userStopped" }
              : { kind: "userCompleted" },
        );
        next = { ...entry, lifecycle, metadata: { ...entry.metadata, snoozed: false } };
      }
      if (entry.entryKind === "thread" && request.method === "workbench/thread-state/archive/set" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped")) next = { ...entry, metadata: request.archived ? { archived: true, pinned: false, snoozed: false } : { archived: false, pinned: false, snoozed: false } };
      const parsed = WorkbenchThreadSidebarEntrySchema.safeParse(next);
      if (!parsed.success) return { accepted: false, revision: state.revision };
      if (areDeeplyEqual(entry, parsed.data)) return { accepted: true, revision: state.revision };
      state.entries.set(key, parsed.data);
      if (parsed.data.entryKind !== "draft") state.overlays.set(key, this.overlayFromEntry(parsed.data));
      await this.persist(request.projectId, state); this.publish(request.projectId, state, parsed.data);
      return { accepted: true, revision: state.revision };
    });
    return request.method === "workbench/thread-state/settle"
      ? await this.options.runGitArcTransition(request.projectId, mutate)
      : await mutate();
  }

  private persist(projectId: string, state: ProjectState) {
    return this.enqueue(`${projectId}:storage:write`, async () => {
      const drafts = [...state.drafts.values()].map((draft): StoredThreadDraft => {
        const entry = state.entries.get(`draft:${draft.draftId}`);
        return {
          ...draft,
          pinned: entry?.entryKind === "draft" ? entry.metadata.pinned : false,
          snoozed: entry?.entryKind === "draft" ? entry.metadata.snoozed : false,
        };
      });
      const threads = [...state.overlays.values()];
      await this.json.write(this.filePath(projectId), { drafts, threads, version: 2 } satisfies StoredProjectState);
    });
  }

  private overlayFromEntry(entry: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>): StoredThreadMetadata {
    return entry.entryKind === "subagent"
      ? { archived: false, harness: entry.identity.harness, lifecycle: entry.lifecycle, pinned: entry.pinned, snoozed: false, threadId: entry.identity.threadId, titleFallback: entry.title }
      : { archived: entry.metadata.archived, harness: entry.identity.harness, lifecycle: entry.lifecycle, pinned: entry.metadata.pinned, snoozed: entry.metadata.snoozed, threadId: entry.identity.threadId, titleFallback: entry.title };
  }
}
