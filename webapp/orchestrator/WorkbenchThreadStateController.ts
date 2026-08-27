/*
 * Exports:
 * - WorkbenchThreadStateControllerOptions/WorkbenchThreadReconciliationFailure/WorkbenchThreadGitArcSnapshot/WorkbenchThreadClaimContext/WorkbenchObservedLifecycleEvent: catalog, project-state and title ports, Git projection, claim context, progressive reconciliation, and identity-owned provider lifecycle input. Keywords: ownership, reconciliation, notification, title, git.
 * - default WorkbenchThreadStateController: own UI-independent thread records, settlement retention timing, fallback storage reads, durable display order, provider observation, and sidebar projection. Keywords: drafts, project, lifecycle, retention, headless.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { WorkbenchProjectsPayload, WorkbenchReloadDirtSnapshot } from "../lib/types";
import { areDeeplyEqual } from "../lib/workbench/deep-equality";
import { WorkbenchProjectStateRequestSchema, type WorkbenchProjectStateRequest, type WorkbenchProjectStateUpdate } from "../lib/workbench/project/project-state";
import { conformToZodSchema } from "../lib/workbench/zod-schema-conformer";
import {
  createWorkbenchThreadFolder,
  getWorkbenchThreadDisplayKey,
  isWorkbenchThreadDisplayOrderEmpty,
  moveWorkbenchThreadDisplayItem,
  normalizeWorkbenchThreadDisplayOrder,
  reconcileWorkbenchThreadDisplayOrder,
  replaceWorkbenchThreadFolderMember,
  renameWorkbenchThreadFolder,
  resolveWorkbenchThreadDisplayOrder,
  sortThreadSidebarEntries,
  type WorkbenchThreadDisplayOrder,
} from "../lib/workbench/thread/thread-display-order";
import {
  areAllUnsnoozedThreadEntriesSettlementReady,
  createWorkbenchProjectThreadSummary,
  WorkbenchThreadDraftSchema,
  WorkbenchThreadSidebarEntrySchema,
  WorkbenchThreadStateRequestSchema,
  gitArcPreventsThreadSettlement,
  getWorkbenchLifecycleTurnId,
  getThreadSidebarGroup,
  isWorkbenchThreadStatusProviderOwned,
  projectWorkbenchThreadSidebarEntries,
  reduceWorkbenchThreadLifecycle,
  resolveWorkbenchThreadTitle,
  type WorkbenchLifecycleEvent,
  type WorkbenchDurableQuestionnaire,
  type WorkbenchQuestionnaireHistoryEntryState,
  type WorkbenchThreadLifecycle,
  type WorkbenchThreadDraft,
  type WorkbenchGitArcLifecycleState,
  type WorkbenchGitArcPlanState,
  type WorkbenchHarnessId,
  type WorkbenchThreadActivityUpdate,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadSidebarSnapshot,
  type WorkbenchThreadStateOpenResultV2,
  type WorkbenchThreadStateOpenResult,
  type WorkbenchThreadStateRequest,
  type WorkbenchThreadStateSnapshot,
} from "../lib/workbench/thread/thread-state";
import AtomicJsonStore from "./AtomicJsonStore";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";
import {
  conformStoredWorkbenchThreadStateRecord,
  parseWorkbenchThreadStateEntry,
  projectWorkbenchThreadStateEntry,
  safeParseWorkbenchThreadStateEntry,
  type WorkbenchThreadStateEntry,
  type WorkbenchThreadStateRecord,
} from "./workbench-thread-state-record";

interface StoredThreadMetadata { archived: boolean; harness: "codex" | "copilot" | "opencode"; lifecycle: WorkbenchThreadLifecycle; mcpGeneration?: string | null; orderAt?: number; pendingQuestionnaire?: WorkbenchDurableQuestionnaire | null; pinned: boolean; questionnaireHistory?: WorkbenchQuestionnaireHistoryEntryState[]; snoozed: boolean; threadId: string; titleFallback?: string }
type StoredThreadDraft = WorkbenchThreadDraft & { pinned?: boolean; snoozed?: boolean };
interface StoredProjectStateV1 { drafts: StoredThreadDraft[]; threads: StoredThreadMetadata[]; version: 1 }
interface StoredProjectStateV2 { drafts: StoredThreadDraft[]; threads: StoredThreadMetadata[]; version: 2 }
interface StoredProjectState { displayOrder?: WorkbenchThreadDisplayOrder; drafts: StoredThreadDraft[]; records: WorkbenchThreadStateRecord[]; version: 3 }
type QuestionnaireStateMutation =
  | { kind: "clear"; requestKey: string }
  | { kind: "set"; questionnaire: WorkbenchDurableQuestionnaire };
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

function reconcileProviderLifecycle(
  providerEntry: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>,
  record: WorkbenchThreadStateRecord | undefined,
): WorkbenchThreadLifecycle {
  if (!record || !isWorkbenchThreadStatusProviderOwned(record.lifecycle) || isWorkbenchThreadStatusProviderOwned(providerEntry.lifecycle)) {
    return record?.lifecycle ?? providerEntry.lifecycle;
  }
  if (
    providerEntry.entryKind === "thread"
    && providerEntry.lifecycle.kind === "completed"
    && providerEntry.lifecycle.reason === "providerInactive"
  ) {
    return { kind: "needsAttention", reason: "noActiveTurn", settled: false };
  }
  return providerEntry.lifecycle;
}

export interface WorkbenchThreadStateControllerOptions {
  getProjectCatalog: () => WorkbenchProjectsPayload;
  getReloadDirt?: () => WorkbenchReloadDirtSnapshot;
  log?: (message: string) => void;
  now?: () => number;
  projectState: {
    getCurrentUpdate: (projectId: string) => WorkbenchProjectStateUpdate | null;
    handleRequest: (projectId: string, request: WorkbenchProjectStateRequest) => Promise<unknown>;
    observe: (projectId: string, publish: (update: WorkbenchProjectStateUpdate) => void) => () => void;
  };
  publish: (connectionId: string, snapshot: WorkbenchThreadStateSnapshot) => void;
  pruneExpiredGitState?: (projectId: string, identities: Array<{ harness: WorkbenchHarnessId; threadId: string }>) => Promise<void>;
  renameThread?: (projectId: string, harness: WorkbenchHarnessId, threadId: string, title: string) => Promise<string>;
  reconcileProject: (
    projectId: string,
    signal: AbortSignal,
    acceptProviderSnapshot: (harness: WorkbenchHarnessId, entries: WorkbenchThreadSidebarEntry[], options: { complete: boolean }) => void,
    acceptGitArcSnapshot: (snapshot: WorkbenchThreadGitArcSnapshot) => Promise<void>,
  ) => Promise<WorkbenchThreadReconciliationFailure[]>;
  resolveGitArc: (projectId: string, harness: WorkbenchHarnessId, threadId: string) => Promise<WorkbenchGitArcLifecycleState | LegacyGitArcClaim | null>;
  resolveGitArcPlan: (projectId: string, harness: WorkbenchHarnessId, threadId: string) => Promise<WorkbenchGitArcPlanState | null>;
  resolveProjectRoot: (projectId: string) => Promise<string>;
  runGitArcTransition: <TValue>(projectId: string, operation: () => Promise<TValue>) => Promise<TValue>;
  storageRoot: string;
  subscribeReloadDirt?: (listener: () => void) => () => void;
}

export interface WorkbenchThreadReconciliationFailure {
  harness: WorkbenchHarnessId;
  message: string;
}

export interface WorkbenchThreadGitArcSnapshot {
  arcs: Array<{ harness: WorkbenchHarnessId; state: WorkbenchGitArcLifecycleState; threadId: string }>;
  plans: Array<{ harness: WorkbenchHarnessId; state: WorkbenchGitArcPlanState; threadId: string }>;
}

export interface WorkbenchThreadClaimContext {
  lifecycle: WorkbenchThreadLifecycle;
  title: string;
}

export type WorkbenchObservedLifecycleEvent =
  | Exclude<WorkbenchLifecycleEvent, { kind: "inputResolved" | "pendingInput" }>
  | { kind: "inputResolved"; requestKey: string }
  | { kind: "pendingInput"; questionnaire: WorkbenchDurableQuestionnaire | null; requestKey: string; turnId: string | null };

interface ProjectState {
  abort: AbortController | null;
  displayOrder: WorkbenchThreadDisplayOrder;
  drafts: Map<string, WorkbenchThreadDraft>;
  entries: Map<string, WorkbenchThreadStateEntry>;
  error: string | null;
  freshness: WorkbenchThreadSidebarSnapshot["freshness"];
  generation: number;
  observers: Set<string>;
  reconcilePromise: Promise<void> | null;
  revision: number;
  stopProjectObservation: (() => void) | null;
}

function entryKey(entry: WorkbenchThreadStateEntry | WorkbenchThreadSidebarEntry) {
  if (entry.entryKind === "draft") return `draft:${entry.draft.draftId}`;
  return `${entry.identity.harness}:${entry.identity.threadId}`;
}

const StoredDraftIdentitySchema = WorkbenchThreadDraftSchema.pick({ draftId: true, harness: true }).strip();

function parseStoredDraft(candidate: unknown, projectId: string) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { error: new Error("Stored draft identity is missing."), success: false as const };
  }
  const { pinned, snoozed, ...draftCandidate } = candidate as Record<string, unknown>;
  const identity = StoredDraftIdentitySchema.safeParse(draftCandidate);
  if (!identity.success) return { error: identity.error, success: false as const };
  const conformed = conformToZodSchema(WorkbenchThreadDraftSchema, { ...draftCandidate, projectId }, {
    agent: null,
    attachments: [],
    clientUpdatedAt: 0,
    composerSettings: {},
    createdAt: 0,
    draftId: identity.data.draftId,
    harness: identity.data.harness,
    model: null,
    profileId: null,
    projectId,
    prompt: "",
    reasoningEffort: null,
    serviceTier: null,
    updatedAt: 0,
  });
  const repairedPaths = [...conformed.repairedPaths];
  if (draftCandidate.projectId !== projectId) repairedPaths.push(["projectId"]);
  if (pinned !== undefined && typeof pinned !== "boolean") repairedPaths.push(["pinned"]);
  if (snoozed !== undefined && typeof snoozed !== "boolean") repairedPaths.push(["snoozed"]);
  return {
    draft: conformed.data,
    metadata: { archived: false as const, pinned: pinned === true, snoozed: snoozed === true },
    repairedPaths,
    success: true as const,
  };
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
  private static readonly SETTLED_GIT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
  private active = true;
  private readonly connectionProjects = new Map<string, { projectId: string; version: 1 | 2 | 3 }>();
  private readonly json = new AtomicJsonStore();
  private readonly now: () => number;
  private readonly options: WorkbenchThreadStateControllerOptions;
  private readonly projects = new Map<string, ProjectState>();
  private readonly operationQueues = new Map<string, Promise<unknown>>();
  private readonly reconciliationPromises = new Set<Promise<void>>();
  private readonly stopReloadDirtSubscription: (() => void) | null;
  private readonly subscribers = new Set<(projectId: string, entry: WorkbenchThreadSidebarEntry) => void>();
  private readonly waitingByThreadKey = new Map<string, "subagents" | "other">();

  constructor(options: WorkbenchThreadStateControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.stopReloadDirtSubscription = options.subscribeReloadDirt?.(() => this.publishReloadDirt()) ?? null;
  }

  subscribe(listener: (projectId: string, entry: WorkbenchThreadSidebarEntry) => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async handleRequest(connectionId: string, input: WorkbenchThreadStateRequest | object) {
    return await this.handleRequestOwned(connectionId, input);
  }

  setThreadWaitState(harness: WorkbenchHarnessId, threadId: string, toolNames: readonly string[]) {
    const key = `${harness}:${threadId}`;
    const waitingFor = toolNames.length
      ? toolNames.every((toolName) => toolName === "subagent_wait") ? "subagents" : "other"
      : null;
    if (this.waitingByThreadKey.get(key) === waitingFor || (!waitingFor && !this.waitingByThreadKey.has(key))) return;
    if (waitingFor) this.waitingByThreadKey.set(key, waitingFor);
    else this.waitingByThreadKey.delete(key);
    for (const [projectId, state] of this.projects) {
      if (state.entries.has(key)) this.publish(projectId, state);
    }
  }

  private async handleRequestOwned(connectionId: string, input: WorkbenchThreadStateRequest | object) {
    const projectRequest = WorkbenchProjectStateRequestSchema.safeParse(input);
    if (projectRequest.success) {
      const observedProjectId = this.connectionProjects.get(connectionId)?.projectId;
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
      case "workbench/thread-state/title/set": {
        if (this.connectionProjects.get(connectionId)?.projectId !== request.projectId) {
          return { error: { code: "invalidProjectObservation", message: "The title request does not belong to this connection's observed project." } };
        }
        try {
          return { result: await this.renameThread(request) };
        } catch (error) {
          return { error: { code: "threadTitleMutationFailed", message: sanitizeError(error) } };
        }
      }
      case "workbench/thread-state/draft/upsert": return { result: await this.upsertDraft(request.projectId, request.draft, request.folderId) };
      case "workbench/thread-state/draft/delete": return { result: await this.deleteDraft(request.projectId, request.draftId, request.clientUpdatedAt) };
      case "workbench/thread-state/draft/pin/set":
      case "workbench/thread-state/draft/snooze/set": return { result: await this.mutateDraft(request) };
      case "workbench/thread-state/display-order/folder/create":
      case "workbench/thread-state/display-order/folder/title/set":
      case "workbench/thread-state/display-order/move": return { result: await this.mutateDisplayOrder(request) };
      default: return { result: await this.mutateThread(request) };
    }
  }

  async open(connectionId: string, projectId: string): Promise<WorkbenchThreadStateOpenResultV2>;
  async open(connectionId: string, projectId: string, version: 3): Promise<WorkbenchThreadStateOpenResult>;
  async open(connectionId: string, projectId: string, version: 2): Promise<WorkbenchThreadStateOpenResultV2>;
  async open(connectionId: string, projectId: string, version: 1): Promise<WorkbenchThreadSidebarSnapshot>;
  async open(connectionId: string, projectId: string, version: 1 | 2 | 3): Promise<WorkbenchThreadSidebarSnapshot | WorkbenchThreadStateOpenResultV2 | WorkbenchThreadStateOpenResult>;
  async open(connectionId: string, projectId: string, version: 1 | 2 | 3 = 2): Promise<WorkbenchThreadSidebarSnapshot | WorkbenchThreadStateOpenResultV2 | WorkbenchThreadStateOpenResult> {
    const priorProjectId = this.connectionProjects.get(connectionId)?.projectId;
    if (priorProjectId && priorProjectId !== projectId) await this.close(connectionId, priorProjectId);
    const state = await this.getProject(projectId);
    this.connectionProjects.set(connectionId, { projectId, version });
    state.observers.add(connectionId);
    const currentProjectUpdate = this.options.projectState.getCurrentUpdate(projectId);
    if (currentProjectUpdate) {
      this.options.publish(connectionId, currentProjectUpdate);
      this.options.log?.(`project replayed connection=${sanitizeLogValue(connectionId)} project=${sanitizeLogValue(projectId)} revision=${currentProjectUpdate.revision}`);
    }
    const sidebar = this.snapshot(projectId, state);
    if (version === 1) return sidebar;
    const catalog = this.options.getProjectCatalog();
    const composite = {
      catalog,
      project: currentProjectUpdate ?? this.options.projectState.getCurrentUpdate(projectId),
      sidebar,
    };
    if (version === 2) return composite;
    return {
      ...composite,
      projectThreads: {
        projects: await Promise.all(catalog.data.map(({ id }) => this.getProjectThreadSummary(id))),
      },
    };
  }

  async close(connectionId: string, expectedProjectId?: string) {
    const projectId = this.connectionProjects.get(connectionId)?.projectId;
    if (!projectId || (expectedProjectId && projectId !== expectedProjectId)) return;
    this.connectionProjects.delete(connectionId);
    const state = this.projects.get(projectId);
    if (!state) return;
    state.observers.delete(connectionId);
  }

  private synchronizeSettlementTimestamps(state: ProjectState) {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of state.entries) {
      if (entry.entryKind === "draft") continue;
      const settledAt = entry.lifecycle.settled ? entry.settledAt ?? now : null;
      const gitHistoryCleanedAt = entry.lifecycle.settled && entry.settledAt !== null
        ? entry.gitHistoryCleanedAt
        : null;
      if (entry.settledAt === settledAt && entry.gitHistoryCleanedAt === gitHistoryCleanedAt) continue;
      state.entries.set(key, { ...entry, gitHistoryCleanedAt, settledAt });
      changed = true;
    }
    return changed;
  }

  private expiredSettledRecords(state: ProjectState) {
    const cutoff = this.now() - WorkbenchThreadStateController.SETTLED_GIT_RETENTION_MS;
    return [...state.entries.entries()].flatMap(([key, entry]) => (
      entry.entryKind !== "draft"
      && entry.lifecycle.settled
      && entry.settledAt !== null
      && entry.settledAt <= cutoff
      && (entry.gitHistoryCleanedAt === null || entry.gitHistoryCleanedAt < entry.settledAt)
        ? [{ identity: entry.identity, key, settledAt: entry.settledAt }]
        : []
    ));
  }

  async disconnect(connectionId: string) { await this.close(connectionId); }

  async acceptIntent(connectionId: string, input: { draftId?: string; harness: "codex" | "copilot" | "opencode"; projectId: string; threadId: string; title?: string; turnId: string }) {
    if (this.connectionProjects.get(connectionId)?.projectId !== input.projectId) throw new Error("The accepted intent does not belong to this connection's observed project.");
    let draftPinned = false;
    if (input.draftId) {
      const state = await this.getProject(input.projectId);
      const draftKey = `draft:${input.draftId}`;
      const draftEntry = state.entries.get(draftKey);
      draftPinned = draftEntry?.entryKind === "draft" ? draftEntry.metadata.pinned : false;
      state.displayOrder = replaceWorkbenchThreadFolderMember(state.displayOrder, draftKey, `${input.harness}:${input.threadId}`);
      state.drafts.delete(input.draftId);
      state.entries.delete(draftKey);
    }
    const acceptedAt = this.now();
    const providerEntry: WorkbenchThreadSidebarEntry = {
      activityAt: acceptedAt, entryKind: "thread", identity: { harness: input.harness, threadId: input.threadId },
      lifecycle: { agent: { agentStatus: "working", turnId: input.turnId }, kind: "working", reason: "acceptedIntent", settled: false },
      metadata: { archived: false, pinned: draftPinned, snoozed: false }, orderAt: acceptedAt, title: input.title?.trim() || input.threadId,
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
    void this.reconcile(projectId, state);
    return this.snapshot(projectId, state);
  }

  async ensureProviderEntry(projectId: string, providerEntry: Exclude<WorkbenchThreadSidebarEntry, { entryKind: "draft" }>) {
    const state = await this.getProject(projectId);
    const key = entryKey(providerEntry);
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const changed = this.installProviderSnapshot(state, providerEntry.identity.harness, [providerEntry], { complete: false });
      if (changed) await this.persist(projectId, state);
      const entry = state.entries.get(key);
      return entry?.entryKind === "draft" ? null : entry ?? null;
    });
  }

  async getMcpGeneration(projectId: string, harness: WorkbenchHarnessId, threadId: string) {
    const state = await this.getProject(projectId);
    const entry = state.entries.get(`${harness}:${threadId}`);
    return entry?.entryKind === "draft" ? null : entry?.mcpGeneration ?? null;
  }

  async setMcpGeneration(projectId: string, harness: WorkbenchHarnessId, threadId: string, generation: string) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") throw new Error("The managed thread is not present in internal thread state.");
      if (entry.mcpGeneration === generation) return entry;
      const next = parseWorkbenchThreadStateEntry({ ...entry, mcpGeneration: generation });
      if (next.entryKind === "draft") throw new Error("MCP generation cannot be stored on a draft.");
      state.entries.set(key, next);
      await this.persist(projectId, state);
      return next;
    });
  }

  async applyLifecycle(
    projectId: string,
    harness: "codex" | "copilot" | "opencode",
    threadId: string,
    event: WorkbenchLifecycleEvent,
    providerEntry?: WorkbenchThreadSidebarEntry,
    questionnaireMutation?: QuestionnaireStateMutation,
  ) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const wakeReadyBefore = areAllUnsnoozedThreadEntriesSettlementReady(this.naturallyOrderedEntries(state));
      if (!state.entries.has(key) && providerEntry?.entryKind === "thread" && entryKey(providerEntry) === key) {
        state.entries.set(key, parseWorkbenchThreadStateEntry({ ...providerEntry, mcpGeneration: null, providerObserved: true }));
      }
      const existing = state.entries.get(key);
      if (!existing || existing.entryKind === "draft") return null;
      const ownedEvent = existing.entryKind === "subagent" && event.kind === "turnCompleted" && event.status === "completed"
        ? { kind: "agentStatus" as const, status: "completed" as const, turnId: event.turnId }
        : event;
      const lifecycle = reduceWorkbenchThreadLifecycle(existing.lifecycle, ownedEvent);
      const shouldUnsnooze = existing.entryKind === "thread" && existing.metadata.snoozed && (
        event.kind === "acceptedIntent"
        || event.kind === "inputResolved"
        || (existing.lifecycle.kind === "working" && (lifecycle.kind === "needsAttention" || lifecycle.kind === "completed" || lifecycle.kind === "stopped"))
      );
      const shouldClearQuestionnaire = questionnaireMutation?.kind === "clear"
        && existing.pendingQuestionnaire?.requestKey === questionnaireMutation.requestKey;
      const shouldSetQuestionnaire = questionnaireMutation?.kind === "set"
        && !areDeeplyEqual(existing.pendingQuestionnaire, questionnaireMutation.questionnaire);
      if (
        event.kind !== "acceptedIntent"
        && areDeeplyEqual(existing.lifecycle, lifecycle)
        && !shouldUnsnooze
        && !shouldClearQuestionnaire
        && !shouldSetQuestionnaire
      ) return existing;
      const activityAt = event.kind === "acceptedIntent" && providerEntry?.entryKind === "thread" ? providerEntry.activityAt : this.now();
      const lifecycleEntry = existing.entryKind === "subagent"
        ? { ...existing, activityAt, lifecycle }
        : {
          ...existing,
          activityAt,
          lifecycle,
          metadata: existing.metadata.archived
            ? { archived: true as const, pinned: false as const, snoozed: false as const }
            : { ...existing.metadata, snoozed: shouldUnsnooze ? false : existing.metadata.snoozed },
          ...(event.kind === "acceptedIntent" ? { orderAt: providerEntry?.entryKind === "thread" ? providerEntry.orderAt ?? activityAt : activityAt } : {}),
          ...(event.kind === "acceptedIntent" && providerEntry?.entryKind === "thread" ? {
            title: resolveWorkbenchThreadTitle({ id: threadId, name: existing.title, preview: providerEntry.title }),
          } : {}),
        };
      const next = questionnaireMutation?.kind === "set"
        ? { ...lifecycleEntry, pendingQuestionnaire: questionnaireMutation.questionnaire }
        : shouldClearQuestionnaire
          ? { ...lifecycleEntry, pendingQuestionnaire: null }
          : lifecycleEntry;
      const parsedNext = parseWorkbenchThreadStateEntry(next);
      if (parsedNext.entryKind === "draft") throw new Error("Lifecycle transitions cannot produce draft entries.");
      state.entries.set(key, parsedNext);
      if (!wakeReadyBefore && areAllUnsnoozedThreadEntriesSettlementReady(this.naturallyOrderedEntries(state))) {
        const highestSnoozed = this.snapshot(projectId, state).entries.find((candidate) => getThreadSidebarGroup(candidate) === "snoozed");
        if (highestSnoozed) {
          const candidateKey = getWorkbenchThreadDisplayKey(highestSnoozed);
          const candidate = state.entries.get(candidateKey);
          if (candidate && candidate.entryKind !== "subagent" && !candidate.metadata.archived && candidate.metadata.snoozed) {
            state.entries.set(candidateKey, parseWorkbenchThreadStateEntry({ ...candidate, metadata: { ...candidate.metadata, snoozed: false } }));
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
      const questionnaireMutation = event.kind === "pendingInput" && event.questionnaire
        ? { kind: "set" as const, questionnaire: event.questionnaire }
        : event.kind === "inputResolved"
          ? { kind: "clear" as const, requestKey: event.requestKey }
          : undefined;
      if (exactEvent) {
        await this.applyLifecycle(projectId, harness, threadId, exactEvent, undefined, questionnaireMutation);
      } else if (questionnaireMutation) {
        await this.updateQuestionnaireState(projectId, harness, threadId, questionnaireMutation);
      }
    }
  }

  private async updateQuestionnaireState(
    projectId: string,
    harness: WorkbenchHarnessId,
    threadId: string,
    mutation: QuestionnaireStateMutation,
  ) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const existing = state.entries.get(key);
      if (!existing || existing.entryKind === "draft") return null;
      const shouldClear = mutation.kind === "clear" && existing.pendingQuestionnaire?.requestKey === mutation.requestKey;
      const next = parseWorkbenchThreadStateEntry({
        ...existing,
        ...(mutation.kind === "set" ? { pendingQuestionnaire: mutation.questionnaire } : shouldClear ? { pendingQuestionnaire: null } : {}),
      });
      if (next.entryKind === "draft" || areDeeplyEqual(existing, next)) return existing;
      state.entries.set(key, next);
      await this.persist(projectId, state);
      this.publish(projectId, state, next);
      return next;
    });
  }

  async observeActivity(harness: "codex" | "copilot" | "opencode", threadId: string, turnStartedAt?: number | null) {
    const key = `${harness}:${threadId}`;
    for (const [projectId, state] of this.projects) {
      if (!state.entries.has(key)) continue;
      await this.enqueue(`${projectId}:thread:${key}`, async () => {
        const entry = state.entries.get(key);
        if (!entry || entry.entryKind === "draft") return;
        const activityAt = this.now();
        const updatesOrder = entry.entryKind === "thread" && turnStartedAt !== undefined;
        const next = parseWorkbenchThreadStateEntry({
          ...entry,
          activityAt,
          ...(updatesOrder ? { orderAt: turnStartedAt ?? activityAt } : {}),
        });
        if (next.entryKind === "draft") return;
        state.entries.set(key, next);
        if (updatesOrder && next.entryKind === "thread") {
          await this.persist(projectId, state);
        }
        if (!this.active || !state.observers.size) return;
        state.revision += 1;
        this.publishUpdate(state, {
          activityAt: next.activityAt,
          displayOrder: state.displayOrder,
          identity: next.identity,
          ...(updatesOrder && next.entryKind === "thread" ? { orderAt: next.orderAt } : {}),
          projectId,
          revision: state.revision,
          updateKind: "activity",
        } satisfies WorkbenchThreadActivityUpdate);
      });
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
    return await this.enqueue(`${projectId}:thread:${key}`, async () => await this.setTitleOwned(projectId, state, key, title));
  }

  private async renameThread(request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/title/set" }>) {
    const renameThread = this.options.renameThread;
    if (!renameThread) throw new Error("Thread title mutation is unavailable.");
    const state = await this.getProject(request.projectId);
    const key = `${request.identity.harness}:${request.identity.threadId}`;
    return await this.enqueue(`${request.projectId}:thread:${key}`, async () => {
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") throw new Error("The thread is not available in the observed project.");
      const title = await renameThread(request.projectId, request.identity.harness, request.identity.threadId, request.title);
      const renamed = await this.setTitleOwned(request.projectId, state, key, title);
      if (!renamed) throw new Error("The renamed thread is no longer available in the observed project.");
      return { identity: request.identity, ok: true as const, title };
    });
  }

  private async setTitleOwned(projectId: string, state: ProjectState, key: string, title: string) {
    const entry = state.entries.get(key);
    if (!entry || entry.entryKind === "draft") return null;
    const next = parseWorkbenchThreadStateEntry({ ...entry, title });
    if (next.entryKind === "draft") return null;
    if (areDeeplyEqual(entry, next)) return next;
    state.entries.set(key, next);
    await this.persist(projectId, state);
    this.publish(projectId, state, next);
    return next;
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
    const storedEntry = stored.records.find((candidate) => candidate.identity.harness === harness && candidate.identity.threadId === threadId);
    const lifecycle = storedEntry?.lifecycle ?? (entry && entry.entryKind !== "draft" ? entry.lifecycle : null);
    if (!lifecycle) return null;
    return {
      lifecycle,
      title: entry?.title ?? storedEntry?.title.trim() ?? threadId,
    };
  }

  async refreshGitArcState(projectId: string, harness: WorkbenchHarnessId, threadId: string) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") return null;
      const [resolvedGitArc, gitArcPlan] = await Promise.all([
        this.options.resolveGitArc(projectId, harness, threadId),
        this.options.resolveGitArcPlan(projectId, harness, threadId),
      ]);
      const gitArc = normalizeResolvedGitArc(resolvedGitArc);
      const next = parseWorkbenchThreadStateEntry({ ...entry, gitArc, gitArcPlan });
      if (next.entryKind === "draft") return null;
      if (areDeeplyEqual(entry, next)) return next;
      state.entries.set(key, next);
      await this.persist(projectId, state);
      this.publish(projectId, state, next);
      return next;
    });
  }

  async dispose() {
    this.active = false;
    this.stopReloadDirtSubscription?.();
    this.waitingByThreadKey.clear();
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
      const entries = new Map<string, WorkbenchThreadStateEntry>();
      for (const storedDraft of stored.drafts) {
        const { pinned, snoozed, ...draft } = storedDraft;
        drafts.set(draft.draftId, draft);
        entries.set(`draft:${draft.draftId}`, this.draftEntry(draft, { archived: false, pinned: pinned === true, snoozed: snoozed === true }));
      }
      for (const record of stored.records) {
        entries.set(entryKey(record), record);
      }
      const state: ProjectState = { abort: null, displayOrder: stored.displayOrder ?? {}, drafts, entries, error: null, freshness: "loading", generation: 0, observers: new Set(), reconcilePromise: null, revision: 0, stopProjectObservation: null };
      const repairedSettlementTimestamps = this.synchronizeSettlementTimestamps(state);
      state.stopProjectObservation = this.options.projectState.observe(projectId, (update) => this.publishUpdate(state, update));
      this.projects.set(projectId, state);
      if (repairedSettlementTimestamps) await this.persist(projectId, state);
      setTimeout(() => {
        if (this.active) void this.reconcile(projectId, state);
      }, 0);
    });
    const loaded = this.projects.get(projectId);
    if (!loaded) throw new Error(`Project state failed to load: ${projectId}`);
    return loaded;
  }

  private loadProjectStorage(projectId: string) {
    return this.enqueue(`${projectId}:storage:read`, async (): Promise<StoredProjectState> => {
      const canonicalPath = this.filePath(projectId);
      const canonicalExists = await this.fileExists(canonicalPath);
      if (canonicalExists) {
        const stored = await this.json.read<StoredProjectState | StoredProjectStateV2 | StoredProjectStateV1>(canonicalPath, { drafts: [], records: [], version: 3 });
        return this.decodeStoredProjectState(stored, projectId);
      }

      const projectRoot = await this.options.resolveProjectRoot(projectId);
      const legacyPath = this.legacyFilePath(projectRoot, projectId);
      if (!await this.fileExists(legacyPath)) return { drafts: [], records: [], version: 3 };
      const legacy = await this.json.read<StoredProjectStateV1>(legacyPath, { drafts: [], threads: [], version: 1 });
      return this.decodeStoredProjectState(legacy, projectId);
    });
  }

  private async getProjectThreadSummary(projectId: string) {
    const state = this.projects.get(projectId);
    if (state) {
      return createWorkbenchProjectThreadSummary(projectId, this.naturallyOrderedEntries(state), state.revision);
    }
    const stored = await this.loadProjectStorage(projectId);
    const entries = stored.records.flatMap((record) => {
      const projected = projectWorkbenchThreadStateEntry(record);
      return projected ? [projected] : [];
    });
    return createWorkbenchProjectThreadSummary(projectId, entries, 0);
  }

  private decodeStoredProjectState(stored: Partial<StoredProjectState | StoredProjectStateV2 | StoredProjectStateV1>, projectId: string): StoredProjectState {
    const records = stored.version === 3 && Array.isArray(stored.records)
      ? stored.records.map((entry) => {
        const parsed = conformStoredWorkbenchThreadStateRecord(entry, projectId);
        if (!parsed.success) throw new Error("Stored thread state contains a provider record without a recoverable identity.");
        this.logStorageRepairs(projectId, entryKey(parsed.data), parsed.repairedPaths);
        return parsed.data;
      })
      : "threads" in stored && Array.isArray(stored.threads)
        ? stored.threads.map((entry) => {
          const parsed = recordFromStoredMetadata(entry, projectId);
          if (!parsed.success) throw new Error("Legacy thread state contains a provider record without a recoverable identity.");
          this.logStorageRepairs(projectId, entryKey(parsed.data), parsed.repairedPaths);
          return parsed.data;
        })
        : [];
    const drafts = Array.isArray(stored.drafts)
      ? stored.drafts.map((entry) => {
        const parsed = parseStoredDraft(entry, projectId);
        if (!parsed.success) throw new Error("Stored thread state contains a draft without a recoverable identity.");
        this.logStorageRepairs(projectId, `draft:${parsed.draft.draftId}`, parsed.repairedPaths);
        return { ...parsed.draft, pinned: parsed.metadata.pinned, snoozed: parsed.metadata.snoozed };
      })
      : [];
    return {
      ...("displayOrder" in stored && !isWorkbenchThreadDisplayOrderEmpty(stored.displayOrder)
        ? { displayOrder: normalizeWorkbenchThreadDisplayOrder(stored.displayOrder) }
        : {}),
      drafts,
      records,
      version: 3,
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
  private draftEntry(draft: WorkbenchThreadDraft, metadata = { archived: false as const, pinned: false, snoozed: false }): Extract<WorkbenchThreadStateEntry, { entryKind: "draft" }> { return { activityAt: draft.updatedAt, draft, entryKind: "draft", metadata, title: draft.prompt.trim().split(/\r?\n/u).find(Boolean)?.trim().replace(/\s+/gu, " ") || "Draft" }; }
  private naturallyOrderedEntries(state: ProjectState) {
    const entries = [...state.entries.values()].flatMap((entry) => {
      const projected = projectWorkbenchThreadStateEntry(entry);
      if (!projected || projected.entryKind === "draft") return projected ? [projected] : [];
      const waitingFor = this.waitingByThreadKey.get(entryKey(projected));
      return [{ ...projected, ...(waitingFor ? { waitingFor } : {}) }];
    });
    return sortThreadSidebarEntries(projectWorkbenchThreadSidebarEntries(entries)).filter((entry) => getThreadSidebarGroup(entry) !== "hidden");
  }

  private logStorageRepairs(projectId: string, entryId: string, repairedPaths: PropertyKey[][]) {
    if (!repairedPaths.length) return;
    const paths = repairedPaths
      .slice(0, 20)
      .map((repairPath) => repairPath.length ? repairPath.map(sanitizeLogValue).join(".") : "root")
      .join(",");
    this.options.log?.(`Conformed stored thread state: project=${sanitizeLogValue(projectId)} entry=${sanitizeLogValue(entryId)} repairedPaths=${paths || "none"}`);
  }
  private snapshot(projectId: string, state: ProjectState): WorkbenchThreadSidebarSnapshot {
    const naturallyOrdered = this.naturallyOrderedEntries(state);
    const resolved = resolveWorkbenchThreadDisplayOrder(naturallyOrdered, state.displayOrder);
    return {
      ...resolved,
      error: state.error,
      freshness: state.freshness,
      projectId,
      ...(this.options.getReloadDirt ? { reloadDirt: this.options.getReloadDirt() } : {}),
      revision: state.revision,
    };
  }
  private publishReloadDirt() {
    if (!this.active) return;
    for (const [projectId, state] of this.projects) this.publish(projectId, state);
  }
  private publish(projectId: string, state: ProjectState, changedEntry?: WorkbenchThreadStateEntry) {
    if (!this.active) return;
    state.revision += 1;
    if (state.observers.size) this.publishUpdate(state, this.snapshot(projectId, state));
    const summary = createWorkbenchProjectThreadSummary(projectId, this.naturallyOrderedEntries(state), state.revision);
    for (const [connectionId, observation] of this.connectionProjects) {
      if (observation.version === 3) {
        this.options.publish(connectionId, { summary, updateKind: "projectThreadSummary" });
      }
    }
    const projected = changedEntry ? projectWorkbenchThreadStateEntry(changedEntry) : null;
    if (projected && state.observers.size) for (const listener of this.subscribers) listener(projectId, projected);
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
    const dirtyHarnesses = new Set<WorkbenchHarnessId>();
    const reconcilePromise = (async () => {
      try {
        let retentionFailure: string | null = null;
        const expiredRecords = this.expiredSettledRecords(state);
        if (expiredRecords.length && this.options.pruneExpiredGitState) {
          try {
            await this.options.pruneExpiredGitState(projectId, expiredRecords.map(({ identity }) => identity));
            const gitHistoryCleanedAt = this.now();
            let cleaned = false;
            for (const expired of expiredRecords) {
              const current = state.entries.get(expired.key);
              if (
                !current
                || current.entryKind === "draft"
                || !current.lifecycle.settled
                || current.settledAt !== expired.settledAt
              ) continue;
              state.entries.set(expired.key, { ...current, gitHistoryCleanedAt });
              cleaned = true;
            }
            if (cleaned) await this.persist(projectId, state);
          } catch (error) {
            retentionFailure = `git-retention: ${sanitizeError(error)}`;
            this.options.log?.(`Git retention failed project=${sanitizeLogValue(projectId)} error=${sanitizeError(error)}`);
          }
        }
        const failures = await this.options.reconcileProject(projectId, abort.signal, (harness, entries, options) => {
          if (!this.active || generation !== state.generation) return;
          if (this.installProviderSnapshot(state, harness, entries, options)) dirtyHarnesses.add(harness);
          if (options.complete && dirtyHarnesses.delete(harness)) {
            void this.persist(projectId, state).catch((error) => {
              if (!this.active || generation !== state.generation) return;
              state.error = sanitizeError(error);
              state.freshness = "partial";
              this.publish(projectId, state);
            });
          }
          state.error = null;
          state.freshness = "partial";
          this.publish(projectId, state);
        }, async (snapshot) => {
          if (!this.active || generation !== state.generation) return;
          if (!this.installGitArcSnapshot(state, snapshot)) return;
          await this.persist(projectId, state);
          this.publish(projectId, state);
        });
        if (!this.active || generation !== state.generation) return;
        const failureMessages = [
          ...(retentionFailure ? [retentionFailure] : []),
          ...failures.map((failure) => `${failure.harness}: ${sanitizeError(failure.message)}`),
        ];
        state.error = failureMessages.length
          ? failureMessages.join("; ").slice(0, 500)
          : null;
        state.freshness = failureMessages.length ? "partial" : "fresh";
        this.publish(projectId, state);
      } catch (error) {
        if (generation !== state.generation || abort.signal.aborted) return;
        const message = sanitizeError(error);
        this.options.log?.(`reconciliation failed project=${sanitizeLogValue(projectId)} error=${message}`);
        state.error = message;
        state.freshness = "partial";
        this.publish(projectId, state);
      }
    })().finally(() => {
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
    let changed = false;
    const install = (key: string, entry: WorkbenchThreadStateEntry) => {
      if (areDeeplyEqual(state.entries.get(key), entry)) return;
      state.entries.set(key, entry);
      changed = true;
    };
    const providerKeys = new Set<string>();
    for (const candidate of entries) {
      const parsed = WorkbenchThreadSidebarEntrySchema.safeParse(candidate);
      if (!parsed.success || parsed.data.entryKind === "draft" || parsed.data.identity.harness !== harness) continue;
      const key = entryKey(parsed.data);
      providerKeys.add(key);
      const existingEntry = state.entries.get(key);
      const existing = existingEntry?.entryKind === "draft" ? undefined : existingEntry;
      const providerEntry = existing
        ? {
          ...parsed.data,
          activityAt: existing.activityAt,
          ...(parsed.data.gitArc === undefined && existing.gitArc !== undefined ? { gitArc: existing.gitArc } : {}),
          ...(parsed.data.gitArcPlan === undefined && existing.gitArcPlan !== undefined ? { gitArcPlan: existing.gitArcPlan } : {}),
        }
        : parsed.data;
      if (providerEntry.entryKind === "subagent") {
        const lifecycle = reconcileProviderLifecycle(providerEntry, existing);
        install(key, parseWorkbenchThreadStateEntry(existing ? {
          ...providerEntry,
          gitHistoryCleanedAt: existing.gitHistoryCleanedAt,
          lifecycle: gitArcPreventsThreadSettlement(providerEntry.gitArc) && lifecycle.settled ? { ...lifecycle, settled: false as const } : lifecycle,
          mcpGeneration: existing.mcpGeneration,
          ...(existing.pendingQuestionnaire ? { pendingQuestionnaire: existing.pendingQuestionnaire } : {}),
          pinned: existing.entryKind === "subagent" ? existing.pinned : existing.metadata.pinned,
          providerObserved: true,
          settledAt: existing.settledAt,
          ...(existing.questionnaireHistory?.length ? { questionnaireHistory: existing.questionnaireHistory } : {}),
        } : { ...providerEntry, mcpGeneration: null, providerObserved: true }));
        continue;
      }
      const metadata = existing?.entryKind === "thread" && existing.metadata.archived
        ? { archived: true as const, pinned: false as const, snoozed: false as const }
        : { archived: false as const, pinned: existing?.entryKind === "thread" ? existing.metadata.pinned : providerEntry.metadata.pinned, snoozed: existing?.entryKind === "thread" ? existing.metadata.snoozed : providerEntry.metadata.snoozed };
      const lifecycle = reconcileProviderLifecycle(providerEntry, existing);
      install(key, parseWorkbenchThreadStateEntry(existing ? {
        ...providerEntry,
        gitHistoryCleanedAt: existing.gitHistoryCleanedAt,
        lifecycle: gitArcPreventsThreadSettlement(providerEntry.gitArc) && lifecycle.settled
          ? { ...lifecycle, settled: false as const }
          : lifecycle,
        mcpGeneration: existing.mcpGeneration,
        metadata,
        ...(existing.entryKind === "thread" && existing.orderAt !== undefined ? { orderAt: existing.orderAt } : {}),
        ...(existing.pendingQuestionnaire ? { pendingQuestionnaire: existing.pendingQuestionnaire } : {}),
        providerObserved: true,
        settledAt: existing.settledAt,
        ...(existing.questionnaireHistory?.length ? { questionnaireHistory: existing.questionnaireHistory } : {}),
        title: providerEntry.title === "New thread" ? existing.title : providerEntry.title,
      } : { ...providerEntry, mcpGeneration: null, providerObserved: true }));
    }
    if (!complete) return changed;
    for (const [key, entry] of state.entries) {
      const isAcceptedIntentAwaitingProvider = entry.entryKind !== "draft"
        && entry.lifecycle.kind === "working"
        && entry.lifecycle.reason === "acceptedIntent";
      if (entry.entryKind !== "draft" && entry.identity.harness === harness && !providerKeys.has(key) && !isAcceptedIntentAwaitingProvider) {
        install(key, { ...entry, providerObserved: false });
      }
    }
    return changed;
  }

  private installGitArcSnapshot(state: ProjectState, snapshot: WorkbenchThreadGitArcSnapshot) {
    const arcs = new Map(snapshot.arcs.map(({ harness, state: gitArc, threadId }) => [`${harness}:${threadId}`, gitArc]));
    const plans = new Map(snapshot.plans.map(({ harness, state: gitArcPlan, threadId }) => [`${harness}:${threadId}`, gitArcPlan]));
    let changed = false;
    for (const [key, entry] of state.entries) {
      if (entry.entryKind === "draft") continue;
      const gitArc = arcs.get(key) ?? null;
      const next = parseWorkbenchThreadStateEntry({
        ...entry,
        gitArc,
        gitArcPlan: plans.get(key) ?? null,
        lifecycle: gitArcPreventsThreadSettlement(gitArc) && entry.lifecycle.settled
          ? { ...entry.lifecycle, settled: false as const }
          : entry.lifecycle,
      });
      if (next.entryKind === "draft" || areDeeplyEqual(entry, next)) continue;
      state.entries.set(key, next);
      changed = true;
    }
    return changed;
  }

  private enqueue<TValue>(key: string, operation: () => Promise<TValue>) {
    const previous = this.operationQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operationQueues.set(key, next);
    return next.finally(() => { if (this.operationQueues.get(key) === next) this.operationQueues.delete(key); });
  }

  private async upsertDraft(projectId: string, draft: WorkbenchThreadDraft, folderId?: string) {
    const state = await this.getProject(projectId);
    return await this.enqueue(folderId ? `${projectId}:display-order` : `${projectId}:draft:${draft.draftId}`, async () => {
      const current = state.drafts.get(draft.draftId);
      if (current && current.clientUpdatedAt > draft.clientUpdatedAt) return { accepted: true, revision: state.revision };
      const targetFolder = folderId ? state.displayOrder.folders?.find((folder) => folder.folderId === folderId) : null;
      if (folderId && (!targetFolder || targetFolder.section === "settled")) return { accepted: false, revision: state.revision };
      const timestamp = this.now();
      const accepted = WorkbenchThreadDraftSchema.parse({ ...draft, createdAt: current?.createdAt ?? timestamp, projectId, updatedAt: timestamp });
      state.drafts.set(accepted.draftId, accepted);
      const existingEntry = state.entries.get(`draft:${accepted.draftId}`);
      const metadata = existingEntry?.entryKind === "draft"
        ? existingEntry.metadata
        : targetFolder
          ? { archived: false as const, pinned: targetFolder.section === "pinned", snoozed: targetFolder.section === "snoozed" }
          : undefined;
      const entry = this.draftEntry(accepted, metadata);
      state.entries.set(entryKey(entry), entry);
      if (targetFolder) {
        const displayOrder = moveWorkbenchThreadDisplayItem(this.naturallyOrderedEntries(state), state.displayOrder, targetFolder.section, entryKey(entry), targetFolder.folderId, targetFolder.threadKeys[0] ?? null);
        if (!displayOrder) {
          if (current) state.drafts.set(current.draftId, current); else state.drafts.delete(accepted.draftId);
          if (existingEntry) state.entries.set(entryKey(existingEntry), existingEntry); else state.entries.delete(entryKey(entry));
          return { accepted: false, revision: state.revision };
        }
        state.displayOrder = displayOrder;
      }
      await this.persist(projectId, state);
      this.publish(projectId, state, entry);
      return { accepted: true, revision: state.revision };
    });
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
      if (next.entryKind !== "draft") return { accepted: false, revision: state.revision };
      if (areDeeplyEqual(entry, next)) return { accepted: true, revision: state.revision };
      state.entries.set(key, next);
      await this.persist(request.projectId, state);
      this.publish(request.projectId, state, next);
      return { accepted: true, revision: state.revision };
    });
  }

  private async mutateDisplayOrder(request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/display-order/folder/create" | "workbench/thread-state/display-order/folder/title/set" | "workbench/thread-state/display-order/move" }>) {
    const state = await this.getProject(request.projectId);
    return await this.enqueue(`${request.projectId}:display-order`, async () => {
      const entries = this.naturallyOrderedEntries(state);
      const next = request.method === "workbench/thread-state/display-order/folder/create"
        ? createWorkbenchThreadFolder(entries, state.displayOrder, request.folderId, request.sourceKey, request.title)
        : request.method === "workbench/thread-state/display-order/folder/title/set"
          ? renameWorkbenchThreadFolder(entries, state.displayOrder, request.folderId, request.title)
          : moveWorkbenchThreadDisplayItem(entries, state.displayOrder, request.section, request.sourceKey, request.destinationFolderId, request.beforeKey);
      if (!next) return { accepted: false, revision: state.revision };
      if (areDeeplyEqual(next, state.displayOrder)) return { accepted: true, revision: state.revision };
      state.displayOrder = next;
      await this.persist(request.projectId, state);
      this.publish(request.projectId, state);
      return { accepted: true, revision: state.revision };
    });
  }

  private async mutateThread(request: Exclude<WorkbenchThreadStateRequest, { method: "workbench/thread-state/open" | "workbench/thread-state/close" | "workbench/thread-state/refresh" | "workbench/thread-state/draft/upsert" | "workbench/thread-state/draft/delete" | "workbench/thread-state/draft/pin/set" | "workbench/thread-state/draft/snooze/set" | "workbench/thread-state/display-order/folder/create" | "workbench/thread-state/display-order/folder/title/set" | "workbench/thread-state/display-order/move" }>) {
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
        && gitArcPreventsThreadSettlement(normalizeResolvedGitArc(await this.options.resolveGitArc(request.projectId, entry.identity.harness, entry.identity.threadId)))
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
      if (request.method === "workbench/thread-state/questionnaire/dismiss") {
        if (entry.pendingQuestionnaire?.requestKey === request.requestKey) {
          next = { ...entry, pendingQuestionnaire: null };
        } else if (entry.pendingQuestionnaire) {
          return { accepted: false, revision: state.revision };
        }
      }
      if (request.method === "workbench/thread-state/questionnaire/resolve") {
        if (
          request.entry.threadId !== request.identity.threadId
          || entry.pendingQuestionnaire?.requestKey !== request.entry.requestKey
        ) return { accepted: false, revision: state.revision };
        next = {
          ...entry,
          pendingQuestionnaire: null,
          questionnaireHistory: [
            ...(entry.questionnaireHistory ?? []).filter((candidate) => candidate.requestKey !== request.entry.requestKey),
            request.entry,
          ],
        };
      }
      const parsed = safeParseWorkbenchThreadStateEntry(next);
      if (!parsed.success) return { accepted: false, revision: state.revision };
      if (areDeeplyEqual(entry, parsed.data)) return { accepted: true, revision: state.revision };
      state.entries.set(key, parsed.data);
      await this.persist(request.projectId, state); this.publish(request.projectId, state, parsed.data);
      return { accepted: true, revision: state.revision };
    });
    return request.method === "workbench/thread-state/settle"
      ? await this.options.runGitArcTransition(request.projectId, mutate)
      : await mutate();
  }

  private persist(projectId: string, state: ProjectState) {
    this.synchronizeSettlementTimestamps(state);
    state.displayOrder = reconcileWorkbenchThreadDisplayOrder(this.naturallyOrderedEntries(state), state.displayOrder);
    return this.enqueue(`${projectId}:storage:write`, async () => {
      const drafts = [...state.drafts.values()].map((draft): StoredThreadDraft => {
        const entry = state.entries.get(`draft:${draft.draftId}`);
        return {
          ...draft,
          pinned: entry?.entryKind === "draft" ? entry.metadata.pinned : false,
          snoozed: entry?.entryKind === "draft" ? entry.metadata.snoozed : false,
        };
      });
      const records = [...state.entries.values()].filter((entry): entry is WorkbenchThreadStateRecord => entry.entryKind !== "draft");
      await this.json.write(this.filePath(projectId), {
        ...(!isWorkbenchThreadDisplayOrderEmpty(state.displayOrder) ? { displayOrder: state.displayOrder } : {}),
        drafts,
        records,
        version: 3,
      } satisfies StoredProjectState);
    });
  }
}

function recordFromStoredMetadata(candidate: StoredThreadMetadata, projectId: string) {
  return conformStoredWorkbenchThreadStateRecord({
    activityAt: candidate?.orderAt,
    entryKind: "thread",
    identity: { harness: candidate?.harness, threadId: candidate?.threadId },
    lifecycle: candidate?.lifecycle,
    mcpGeneration: typeof candidate.mcpGeneration === "string" ? candidate.mcpGeneration : null,
    metadata: { archived: candidate?.archived, pinned: candidate?.pinned, snoozed: candidate?.snoozed },
    orderAt: candidate?.orderAt,
    pendingQuestionnaire: candidate?.pendingQuestionnaire,
    providerObserved: false,
    questionnaireHistory: candidate?.questionnaireHistory,
    title: candidate?.titleFallback,
  }, projectId);
}
