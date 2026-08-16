/*
 * Exports:
 * - WorkbenchThreadStateControllerOptions/WorkbenchObservedLifecycleEvent: catalog ports and identity-owned provider lifecycle input. Keywords: ownership, reconciliation, notification.
 * - default WorkbenchThreadStateController: reloadable durable metadata and pushed sidebar lifecycle owner. Keywords: drafts, lifecycle, observation, snapshot.
 */
import path from "node:path";

import {
  WorkbenchThreadDraftSchema,
  WorkbenchThreadLifecycleSchema,
  WorkbenchThreadSidebarEntrySchema,
  WorkbenchThreadStateRequestSchema,
  getWorkbenchLifecycleTurnId,
  getThreadSidebarGroup,
  projectWorkbenchThreadSidebarEntries,
  reduceWorkbenchThreadLifecycle,
  sortThreadSidebarEntries,
  type WorkbenchLifecycleEvent,
  type WorkbenchThreadLifecycle,
  type WorkbenchThreadDraft,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadStateRequest,
  type WorkbenchThreadStateSnapshot,
} from "../lib/workbench/thread/thread-state";
import AtomicJsonStore from "./AtomicJsonStore";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";

interface StoredThreadMetadata { archived: boolean; harness: "codex" | "copilot" | "opencode"; lifecycle: WorkbenchThreadLifecycle; pinned: boolean; snoozed: boolean; threadId: string }
interface StoredProjectState { drafts: WorkbenchThreadDraft[]; threads: StoredThreadMetadata[]; version: 1 }

export interface WorkbenchThreadStateControllerOptions {
  now?: () => number;
  publish: (connectionId: string, snapshot: WorkbenchThreadStateSnapshot) => void;
  reconcileProject: (projectId: string, signal: AbortSignal) => Promise<WorkbenchThreadSidebarEntry[]>;
  resolveProjectRoot: (projectId: string) => Promise<string>;
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
  freshness: WorkbenchThreadStateSnapshot["freshness"];
  generation: number;
  observers: Set<string>;
  overlays: Map<string, StoredThreadMetadata>;
  reconcilePromise: Promise<void> | null;
  revision: number;
  root: string;
}

function entryKey(entry: WorkbenchThreadSidebarEntry) {
  if (entry.entryKind === "draft") return `draft:${entry.draft.draftId}`;
  return `${entry.identity.harness}:${entry.identity.threadId}`;
}

function sanitizeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 500);
}

export default class WorkbenchThreadStateController {
  private active = true;
  private readonly connectionProjects = new Map<string, string>();
  private readonly json = new AtomicJsonStore();
  private readonly now: () => number;
  private readonly options: WorkbenchThreadStateControllerOptions;
  private readonly projects = new Map<string, ProjectState>();
  private readonly mutationQueues = new Map<string, Promise<void>>();
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
    const parsed = WorkbenchThreadStateRequestSchema.safeParse(input);
    if (!parsed.success) return { error: { code: "invalidThreadStateMutation", message: parsed.error.issues[0]?.message ?? "Invalid thread-state request." } };
    const request = parsed.data;
    switch (request.method) {
      case "workbench/thread-state/open": return { result: await this.open(connectionId, request.projectId) };
      case "workbench/thread-state/close": await this.close(connectionId, request.projectId); return { result: { accepted: true } };
      case "workbench/thread-state/draft/upsert": return { result: await this.upsertDraft(request.projectId, request.draft) };
      case "workbench/thread-state/draft/delete": return { result: await this.deleteDraft(request.projectId, request.draftId, request.clientUpdatedAt) };
      default: return { result: await this.mutateThread(request) };
    }
  }

  async open(connectionId: string, projectId: string) {
    const priorProjectId = this.connectionProjects.get(connectionId);
    if (priorProjectId && priorProjectId !== projectId) await this.close(connectionId, priorProjectId);
    const state = await this.getProject(projectId);
    this.connectionProjects.set(connectionId, projectId);
    const wasUnobserved = state.observers.size === 0;
    state.observers.add(connectionId);
    if (wasUnobserved) {
      setTimeout(() => {
        if (this.active && state.observers.size) void this.reconcile(projectId, state);
      }, 0);
    }
    return this.snapshot(projectId, state);
  }

  async close(connectionId: string, expectedProjectId?: string) {
    const projectId = this.connectionProjects.get(connectionId);
    if (!projectId || (expectedProjectId && projectId !== expectedProjectId)) return;
    this.connectionProjects.delete(connectionId);
    const state = this.projects.get(projectId);
    if (!state) return;
    state.observers.delete(connectionId);
    if (!state.observers.size) { state.generation += 1; state.abort?.abort(); state.abort = null; }
  }

  async disconnect(connectionId: string) { await this.close(connectionId); }

  async acceptIntent(connectionId: string, input: { harness: "codex" | "copilot" | "opencode"; projectId: string; threadId: string; turnId: string }) {
    if (this.connectionProjects.get(connectionId) !== input.projectId) throw new Error("The accepted intent does not belong to this connection's observed project.");
    const providerEntry: WorkbenchThreadSidebarEntry = {
      activityAt: this.now(), entryKind: "thread", identity: { harness: input.harness, threadId: input.threadId },
      lifecycle: { agent: { agentStatus: "working", turnId: input.turnId }, kind: "working", reason: "acceptedIntent", settled: false },
      metadata: { archived: false, pinned: false, snoozed: false }, title: input.threadId,
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
    const activeBefore = this.countActiveQueueEntries(state);
    const key = `${harness}:${threadId}`;
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

  async getSnapshot(projectId: string) {
    const state = await this.getProject(projectId);
    return this.snapshot(projectId, state);
  }

  async dispose() {
    this.active = false;
    for (const state of this.projects.values()) { state.generation += 1; state.abort?.abort(); }
    await Promise.allSettled([...this.mutationQueues.values(), ...[...this.projects.values()].map((state) => state.reconcilePromise)]);
    await this.json.waitForIdle();
  }

  private async getProject(projectId: string) {
    const current = this.projects.get(projectId);
    if (current) return current;
    const root = await this.options.resolveProjectRoot(projectId);
    const stored = await this.json.read<StoredProjectState>(this.filePath(root, projectId), { drafts: [], threads: [], version: 1 });
    const drafts = new Map<string, WorkbenchThreadDraft>();
    for (const candidate of Array.isArray(stored.drafts) ? stored.drafts : []) {
      const parsed = WorkbenchThreadDraftSchema.safeParse(candidate);
      if (parsed.success && parsed.data.projectId === projectId) drafts.set(parsed.data.draftId, parsed.data);
    }
    const entries = new Map<string, WorkbenchThreadSidebarEntry>();
    for (const draft of drafts.values()) entries.set(`draft:${draft.draftId}`, this.draftEntry(draft));
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
      };
      overlays.set(`${overlay.harness}:${overlay.threadId}`, overlay);
    }
    const state: ProjectState = { abort: null, drafts, entries, error: null, freshness: "loading", generation: 0, observers: new Set(), overlays, reconcilePromise: null, revision: 0, root };
    this.projects.set(projectId, state);
    return state;
  }

  private filePath(root: string, projectId: string) { return path.join(root, ".workbench", "runtime", "thread-state", `${encodeTranscriptPathSegment(projectId)}.json`); }
  private draftEntry(draft: WorkbenchThreadDraft): WorkbenchThreadSidebarEntry { return { activityAt: draft.updatedAt, draft, entryKind: "draft", metadata: { archived: false, pinned: false, snoozed: false }, title: draft.prompt.trim().split(/\r?\n/u).find(Boolean)?.trim().replace(/\s+/gu, " ") || "Draft" }; }
  private snapshot(projectId: string, state: ProjectState): WorkbenchThreadStateSnapshot { return { entries: sortThreadSidebarEntries(projectWorkbenchThreadSidebarEntries([...state.entries.values()])).filter((entry) => getThreadSidebarGroup(entry) !== "hidden"), error: state.error, freshness: state.freshness, projectId, revision: state.revision }; }
  private countActiveQueueEntries(state: ProjectState) { return [...state.entries.values()].filter((entry) => { const group = getThreadSidebarGroup(entry); return group === "drafts" || group === "needsAttention" || group === "completed" || group === "working"; }).length; }

  private publish(projectId: string, state: ProjectState, changedEntry?: WorkbenchThreadSidebarEntry) {
    if (!this.active || !state.observers.size) return;
    state.revision += 1;
    const snapshot = this.snapshot(projectId, state);
    for (const connectionId of state.observers) this.options.publish(connectionId, snapshot);
    if (changedEntry) for (const listener of this.subscribers) listener(projectId, changedEntry);
  }

  private reconcile(projectId: string, state: ProjectState) {
    if (state.reconcilePromise) return state.reconcilePromise;
    const generation = ++state.generation;
    const abort = new AbortController();
    state.abort?.abort();
    state.abort = abort;
    state.freshness = "loading";
    state.reconcilePromise = this.options.reconcileProject(projectId, abort.signal).then((entries) => {
      if (!this.active || generation !== state.generation || !state.observers.size) return;
      const providerKeys = new Set<string>();
      for (const candidate of entries) {
        const parsed = WorkbenchThreadSidebarEntrySchema.safeParse(candidate);
        if (!parsed.success || parsed.data.entryKind === "draft") continue;
        const key = entryKey(parsed.data);
        providerKeys.add(key);
        const overlay = state.overlays.get(key);
        if (parsed.data.entryKind === "subagent") {
          state.entries.set(key, overlay ? { ...parsed.data, lifecycle: overlay.lifecycle, pinned: overlay.pinned } : parsed.data);
          continue;
        }
        const metadata = overlay?.archived
          ? { archived: true as const, pinned: false as const, snoozed: false as const }
          : { archived: false as const, pinned: overlay?.pinned ?? parsed.data.metadata.pinned, snoozed: overlay?.snoozed ?? parsed.data.metadata.snoozed };
        state.entries.set(key, overlay ? { ...parsed.data, lifecycle: overlay.lifecycle, metadata } : parsed.data);
      }
      for (const [key, entry] of state.entries) if (entry.entryKind !== "draft" && !providerKeys.has(key)) state.entries.delete(key);
      state.error = null;
      state.freshness = "fresh";
      this.publish(projectId, state);
    }, (error) => {
      if (generation !== state.generation || abort.signal.aborted) return;
      state.error = sanitizeError(error);
      state.freshness = "partial";
      this.publish(projectId, state);
    }).finally(() => { if (state.reconcilePromise) state.reconcilePromise = null; if (state.abort === abort) state.abort = null; });
    return state.reconcilePromise;
  }

  private enqueue(key: string, operation: () => Promise<void>) {
    const previous = this.mutationQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.mutationQueues.set(key, next);
    return next.finally(() => { if (this.mutationQueues.get(key) === next) this.mutationQueues.delete(key); });
  }

  private async upsertDraft(projectId: string, draft: WorkbenchThreadDraft) {
    const state = await this.getProject(projectId);
    await this.enqueue(`${projectId}:draft:${draft.draftId}`, async () => {
      const current = state.drafts.get(draft.draftId);
      if (current && current.clientUpdatedAt > draft.clientUpdatedAt) return;
      const timestamp = this.now();
      const accepted = WorkbenchThreadDraftSchema.parse({ ...draft, createdAt: current?.createdAt ?? timestamp, projectId, updatedAt: timestamp });
      state.drafts.set(accepted.draftId, accepted);
      const entry = this.draftEntry(accepted);
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

  private async mutateThread(request: Exclude<WorkbenchThreadStateRequest, { method: "workbench/thread-state/open" | "workbench/thread-state/close" | "workbench/thread-state/draft/upsert" | "workbench/thread-state/draft/delete" }>) {
    const state = await this.getProject(request.projectId);
    const key = `${request.identity.harness}:${request.identity.threadId}`;
    const entry = state.entries.get(key);
    if (!entry || entry.entryKind === "draft") return { accepted: false, revision: state.revision };
    let next = entry;
    if (request.method === "workbench/thread-state/pin/set") next = entry.entryKind === "subagent"
      ? { ...entry, pinned: request.pinned }
      : entry.metadata.archived
        ? entry
        : { ...entry, metadata: { archived: false as const, pinned: request.pinned, snoozed: entry.metadata.snoozed } };
    if (entry.entryKind === "thread" && !entry.metadata.archived && request.method === "workbench/thread-state/snooze/set" && !(entry.lifecycle.settled && request.snoozed)) next = { ...entry, metadata: { archived: false, pinned: entry.metadata.pinned, snoozed: request.snoozed } };
    if (request.method === "workbench/thread-state/settle" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped")) next = entry.entryKind === "subagent" ? { ...entry, lifecycle: { ...entry.lifecycle, settled: true }, pinned: false } : { ...entry, lifecycle: { ...entry.lifecycle, settled: true }, metadata: entry.metadata.archived ? entry.metadata : { ...entry.metadata, snoozed: false } };
    if (request.method === "workbench/thread-state/restore" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped")) next = { ...entry, lifecycle: reduceWorkbenchThreadLifecycle(entry.lifecycle, { kind: "restore" }) };
    if (entry.entryKind === "thread" && request.method === "workbench/thread-state/complete") next = {
      ...entry,
      lifecycle: reduceWorkbenchThreadLifecycle(entry.lifecycle, request.status === "stopped" ? { kind: "userStopped" } : { kind: "userCompleted" }),
    };
    if (entry.entryKind === "thread" && request.method === "workbench/thread-state/archive/set" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped")) next = { ...entry, metadata: request.archived ? { archived: true, pinned: false, snoozed: false } : { archived: false, pinned: false, snoozed: false } };
    const parsed = WorkbenchThreadSidebarEntrySchema.safeParse(next);
    if (!parsed.success) return { accepted: false, revision: state.revision };
    state.entries.set(key, parsed.data);
    if (parsed.data.entryKind !== "draft") state.overlays.set(key, this.overlayFromEntry(parsed.data));
    await this.persist(request.projectId, state); this.publish(request.projectId, state, parsed.data);
    return { accepted: true, revision: state.revision };
  }

  private persist(projectId: string, state: ProjectState) {
    const threads = [...state.overlays.values()];
    return this.json.write(this.filePath(state.root, projectId), { drafts: [...state.drafts.values()], threads, version: 1 } satisfies StoredProjectState);
  }

  private overlayFromEntry(entry: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>): StoredThreadMetadata {
    return entry.entryKind === "subagent"
      ? { archived: false, harness: entry.identity.harness, lifecycle: entry.lifecycle, pinned: entry.pinned, snoozed: false, threadId: entry.identity.threadId }
      : { archived: entry.metadata.archived, harness: entry.identity.harness, lifecycle: entry.lifecycle, pinned: entry.metadata.pinned, snoozed: entry.metadata.snoozed, threadId: entry.identity.threadId };
  }
}
