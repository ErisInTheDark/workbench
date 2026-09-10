/*
 * Exports:
 * - WorkbenchObservedThreadEntry: provider sidebar input with an optional explicit name, separate from display fallback.
 * - WorkbenchThreadStateControllerOptions/WorkbenchThreadReconciliationFailure/WorkbenchThreadGitArcSnapshot/WorkbenchThreadClaimContext/WorkbenchObservedLifecycleEvent: catalog, project-state and title ports, Git projection, claim context, progressive reconciliation, and identity-owned provider lifecycle input.
 * - default WorkbenchThreadStateController: own UI-independent thread records, settlement retention timing, authoritative SQLite state, durable display order, provider observation, and local/cross-project sidebar projection.
 */
import { z } from "zod";

import type { WorkbenchComposerProfileSlot, WorkbenchComposerProfileStorePayload, WorkbenchComposerProfileTargetSelection, WorkbenchProjectsPayload, WorkbenchReloadDirtSnapshot } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { WorkbenchProjectStateRequestSchema, type WorkbenchProjectStateRequest, type WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";
import { DraftIdSchema, ThreadDisplayKeySchema, type DraftId, type ProjectId, type ProjectThreadDisplayKey, type WorkbenchThreadId, type WorkbenchTurnId } from "workbench-shared/workbench/identity";
import { mergeQuestionnaireHistoryEntries } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { dismissThreadTitle, recordThreadTitle } from "workbench-shared/workbench/thread/thread-title-history";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import {
  getWorkbenchHomeThreadKey,
  removeWorkbenchThreadFromProjectFolder,
  resolveWorkbenchHomeThreadSectionKeys,
} from "workbench-shared/workbench/thread/home-thread-display-order";
import {
  getProjectQualifiedThreadDisplayKey,
  getThreadDisplayDraftKey,
  getThreadDisplayThreadKey,
  parseProjectQualifiedThreadDisplayKey,
  type ThreadDisplayLayoutEntry,
} from "workbench-shared/workbench/thread/thread-display-layout";
import {
  createWorkbenchThreadFolder,
  findWorkbenchThreadFolder,
  getWorkbenchThreadDisplayKey,
  getWorkbenchThreadDisplaySection,
  isWorkbenchThreadDisplayOrderEmpty,
  moveWorkbenchThreadDisplayItem,
  normalizeWorkbenchThreadDisplayOrder,
  reconcileWorkbenchThreadDisplayOrder,
  replaceWorkbenchThreadFolderMember,
  renameWorkbenchThreadFolder,
  resolveWorkbenchThreadDisplayOrder,
  sortThreadSidebarEntries,
  type WorkbenchThreadDisplayOrder,
  type WorkbenchThreadDisplaySection,
} from "workbench-shared/workbench/thread/thread-display-order";
import {
  areAllUnsnoozedThreadEntriesSettlementReady,
  createWorkbenchProjectThreadSummary,
  WorkbenchComposerProfileSelectionSchema,
  WorkbenchComposerSettingsSchema,
  WorkbenchHarnessSchema,
  WorkbenchThreadDraftSchema,
  WorkbenchThreadSidebarEntrySchema,
  WorkbenchThreadStateRequestSchema,
  gitArcPreventsThreadSettlement,
  getWorkbenchLifecycleTurnId,
  getThreadSidebarGroup,
  isWorkbenchThreadStatusProviderOwned,
  isWorkbenchSidebarThreadCompletionAvailable,
  projectWorkbenchThreadSidebarEntries,
  reduceWorkbenchThreadLifecycle,
  resolveWorkbenchThreadTitle,
  type WorkbenchLifecycleEvent,
  type WorkbenchComposerProfileSelectionState,
  type WorkbenchDurableQuestionnaire,
  type WorkbenchQuestionnaireHistoryEntryState,
  type WorkbenchThreadLifecycle,
  type WorkbenchThreadDraft,
  type WorkbenchThreadStateDelta,
  type WorkbenchGitArcLifecycleState,
  type WorkbenchGitArcPlanState,
  type WorkbenchHarnessId,
  type WorkbenchThreadActivityUpdate,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadSidebarSnapshot,
  type WorkbenchGlobalThreadStateOpenResult,
  type WorkbenchThreadStateOpenResultV2,
  type WorkbenchThreadStateOpenResult,
  type WorkbenchThreadPriority,
  type WorkbenchThreadStateRequest,
  type WorkbenchThreadStateSnapshot,
  type WorkbenchThreadObservationSnapshot,
  type WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import WorkbenchThreadObservationController, { type ThreadObservationRequest } from "./WorkbenchThreadObservationController";
import WorkbenchHomeThreadDisplayOrderStore from "./WorkbenchHomeThreadDisplayOrderStore";
import WorkbenchPinnedThreadLayoutStore from "./WorkbenchPinnedThreadLayoutStore";
import WorkbenchThreadArchiveController from "./WorkbenchThreadArchiveController";
import type { WorkbenchThreadStatePersistence } from "./WorkbenchThreadStateStore";
import type { WorkbenchThreadStateCommit } from "./database/thread-state/workbench-thread-state-persistence";
import {
  conformStoredWorkbenchThreadStateRecord,
  parseWorkbenchThreadStateEntry,
  projectWorkbenchThreadStateEntry,
  safeParseWorkbenchThreadStateEntry,
  type WorkbenchThreadStateEntry,
  type WorkbenchThreadStateRecord,
  type WorkbenchThreadSnoozeTarget,
} from "./workbench-thread-state-record";

export type WorkbenchObservedThreadEntry = WorkbenchThreadSidebarEntry & { namedTitle?: string };

interface StoredThreadMetadata { archived: boolean; harness: "codex" | "copilot" | "opencode"; lifecycle: WorkbenchThreadLifecycle; mcpGeneration?: string | null; orderAt?: number; pendingQuestionnaire?: WorkbenchDurableQuestionnaire | null; pinned: boolean; questionnaireHistory?: WorkbenchQuestionnaireHistoryEntryState[]; snoozed: boolean; threadId: string; titleFallback?: string }
type StoredThreadDraft = WorkbenchThreadDraft & { pinned?: boolean; snoozed?: boolean };
type ProjectObservation =
  | { pinnedThreadKeys: Set<string>; projectId: ProjectId; scope: "project"; version: 1 | 2 | 3 | 4 | 5 }
  | { pinnedThreadKeys: Set<string>; scope: "global"; version: 4 | 5 | 6 | 7 };
interface StoredProjectStateV1 { drafts: StoredThreadDraft[]; threads: StoredThreadMetadata[]; version: 1 }
interface StoredProjectStateV2 { drafts: StoredThreadDraft[]; threads: StoredThreadMetadata[]; version: 2 }
interface StoredProjectStateV3 { displayOrder?: WorkbenchThreadDisplayOrder; drafts: StoredThreadDraft[]; records: WorkbenchThreadStateRecord[]; version: 3 }
interface StoredProjectState { displayOrder?: WorkbenchThreadDisplayOrder; drafts: StoredThreadDraft[]; newThreadProfile: WorkbenchComposerProfileSelectionState | null; records: WorkbenchThreadStateRecord[]; version: 4 }
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

function sameThreadTarget(
  leftProjectId: string,
  left: { harness: WorkbenchHarnessId; threadId: string },
  rightProjectId: string,
  right: { harness: WorkbenchHarnessId; threadId: string },
) {
  return leftProjectId === rightProjectId && left.harness === right.harness && left.threadId === right.threadId;
}

function setEntryPriority(entry: WorkbenchThreadStateEntry, priority: WorkbenchThreadPriority): WorkbenchThreadStateEntry | null {
  if (entry.entryKind !== "draft" && (entry.entryKind === "subagent" || entry.lifecycle.settled)) return null;
  if (entry.metadata.archived) return null;
  const metadata = priority === "pinned"
    ? { archived: false as const, pinned: true, snoozed: false }
    : priority === "main"
      ? { archived: false as const, pinned: false, snoozed: false }
      : { archived: false as const, pinned: entry.metadata.pinned, snoozed: true };
  return entry.entryKind === "draft"
    ? { ...entry, metadata }
    : { ...entry, metadata, snoozedUntil: null };
}

function setEntryDisplaySection(entry: WorkbenchThreadStateEntry, section: WorkbenchThreadDisplaySection) {
  if (section === "settled") return getWorkbenchThreadDisplaySection(entry) === "settled" ? entry : null;
  return setEntryPriority(entry, section);
}

export interface WorkbenchThreadStateControllerOptions {
  readComposerProfiles?: () => Promise<WorkbenchComposerProfileStorePayload>;
  getProjectCatalog: () => WorkbenchProjectsPayload;
  getReloadDirt?: () => WorkbenchReloadDirtSnapshot;
  hasLiveGitArcClaims: (projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId) => Promise<boolean>;
  log?: (message: string) => void;
  now?: () => number;
  projectState: {
    getCurrentUpdate: (projectId: ProjectId) => WorkbenchProjectStateUpdate | null;
    handleRequest: (projectId: ProjectId, request: WorkbenchProjectStateRequest) => Promise<unknown>;
    observe: (projectId: ProjectId, publish: (update: WorkbenchProjectStateUpdate) => void) => () => void;
  };
  publish: (connectionId: string, snapshot: WorkbenchThreadStateSnapshot) => void;
  pruneExpiredGitState?: (projectId: ProjectId, identities: Array<{ harness: WorkbenchHarnessId; threadId: WorkbenchThreadId }>) => Promise<void>;
  renameThread?: (projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId, title: string) => Promise<string>;
  interruptQuestionnaire?: (projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId, questionnaire: WorkbenchDurableQuestionnaire) => Promise<boolean>;
  reconcileProject: (
    projectId: ProjectId,
    signal: AbortSignal,
    acceptProviderSnapshot: (harness: WorkbenchHarnessId, entries: WorkbenchObservedThreadEntry[], options: { complete: boolean }) => Promise<void>,
    acceptGitArcSnapshot: (snapshot: WorkbenchThreadGitArcSnapshot) => Promise<void>,
  ) => Promise<WorkbenchThreadReconciliationFailure[]>;
  resolveGitArc: (projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId) => Promise<WorkbenchGitArcLifecycleState | LegacyGitArcClaim | null>;
  resolveGitArcPlan: (projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId) => Promise<WorkbenchGitArcPlanState | null>;
  runGitArcReadTransition: <TValue>(projectId: ProjectId, operation: () => Promise<TValue>) => Promise<TValue>;
  subscribeReloadDirt?: (listener: () => void) => () => void;
  threadStateStore: WorkbenchThreadStatePersistence;
}

export interface WorkbenchThreadReconciliationFailure {
  harness: WorkbenchHarnessId;
  message: string;
}

export interface WorkbenchThreadGitArcSnapshot {
  arcs: Array<{ harness: WorkbenchHarnessId; state: WorkbenchGitArcLifecycleState; threadId: WorkbenchThreadId }>;
  plans: Array<{ harness: WorkbenchHarnessId; state: WorkbenchGitArcPlanState; threadId: WorkbenchThreadId }>;
}

export interface WorkbenchThreadClaimContext {
  lifecycle: WorkbenchThreadLifecycle;
  title: string;
}

export type WorkbenchObservedLifecycleEvent =
  | Exclude<WorkbenchLifecycleEvent, { kind: "inputResolved" | "pendingInput" }>
  | { kind: "inputResolved"; requestKey: string }
  | { kind: "pendingInput"; questionnaire: WorkbenchDurableQuestionnaire | null; requestKey: string; turnId: WorkbenchTurnId | null };

interface ProjectState {
  abort: AbortController | null;
  displayOrder: WorkbenchThreadDisplayOrder;
  drafts: Map<string, WorkbenchThreadDraft>;
  entries: Map<string, WorkbenchThreadStateEntry>;
  error: string | null;
  freshness: WorkbenchThreadSidebarSnapshot["freshness"];
  generation: number;
  newThreadProfile: WorkbenchComposerProfileSelectionState | null;
  observers: Set<string>;
  reconcilePromise: Promise<void> | null;
  revision: number;
  stopProjectObservation: (() => void) | null;
}

function entryKey(entry: WorkbenchThreadStateEntry | WorkbenchThreadSidebarEntry) {
  if (entry.entryKind === "draft") return getThreadDisplayDraftKey(entry.draft.draftId);
  return getThreadDisplayThreadKey(entry.identity.harness, entry.identity.threadId);
}

const StoredDraftIdentitySchema = z.object({
  draftId: z.uuid(),
  harness: WorkbenchHarnessSchema,
}).strip();

function parseStoredDraft(candidate: unknown, projectId: ProjectId) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { error: new Error("Stored draft identity is missing."), success: false as const };
  }
  const { pinned, snoozed, ...draftCandidate } = candidate as Record<string, unknown>;
  const storedSettings = WorkbenchComposerSettingsSchema.safeParse(draftCandidate.composerSettings);
  const identity = StoredDraftIdentitySchema.safeParse({ ...draftCandidate, harness: storedSettings.success ? storedSettings.data.harness : draftCandidate.harness });
  if (!identity.success) return { error: identity.error, success: false as const };
  const composerSettings = storedSettings.success
    ? storedSettings.data
    : {
      agentPath: typeof draftCandidate.agent === "string" ? draftCandidate.agent : null,
      agentSource: null,
      harness: identity.data.harness,
      model: typeof draftCandidate.model === "string" ? draftCandidate.model : "",
      reasoningEffort: typeof draftCandidate.reasoningEffort === "string" ? draftCandidate.reasoningEffort : null,
      serviceTier: draftCandidate.serviceTier === "fast" ? "fast" as const : null,
    };
  const conformed = conformToZodSchema(WorkbenchThreadDraftSchema, { ...draftCandidate, projectId }, {
    attachments: [],
    clientUpdatedAt: 0,
    composerSettings,
    createdAt: 0,
    draftId: identity.data.draftId,
    profileId: null,
    projectId,
    prompt: "",
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
  private readonly archives: WorkbenchThreadArchiveController;
  private readonly connectionProjects = new Map<string, ProjectObservation>();
  private readonly homeDisplayOrder: WorkbenchHomeThreadDisplayOrderStore;
  private readonly now: () => number;
  private readonly options: WorkbenchThreadStateControllerOptions;
  private readonly threadObservations: WorkbenchThreadObservationController;
  private readonly pinnedLayout: WorkbenchPinnedThreadLayoutStore;
  private readonly projects = new Map<ProjectId, ProjectState>();
  private readonly operationQueues = new Map<string, Promise<unknown>>();
  private readonly persistenceWrites = new Set<Promise<void>>();
  private readonly retiredError = new Error("Thread-state controller is retired.");
  private readonly pinnedEntries = new Map<string, ThreadDisplayLayoutEntry>();
  private readonly reconciliationPromises = new Set<Promise<void>>();
  private readonly summaryHydrationPromises = new Set<Promise<void>>();
  private readonly stopReloadDirtSubscription: (() => void) | null;
  private readonly subscribers = new Set<(projectId: ProjectId, entry: WorkbenchThreadSidebarEntry) => void>();
  private readonly waitingByThreadKey = new Map<string, "subagents" | "other">();

  constructor(options: WorkbenchThreadStateControllerOptions) {
    const persistence = options.threadStateStore;
    const ownedPersistence: WorkbenchThreadStatePersistence = {
      writeChanges: (projectId, changes) => this.writePersistence(() => persistence.writeChanges(projectId, changes)),
      readNextArchiveEligibility: () => this.readPersistence(() => persistence.readNextArchiveEligibility()),
      readArchiveEligible: before => this.readPersistence(() => persistence.readArchiveEligible(before)),
      readGlobal: id => this.readPersistence(() => persistence.readGlobal(id)),
      readProject: projectId => this.readPersistence(() => persistence.readProject(projectId)),
      readTitleHistories: projectId => this.readPersistence(() => persistence.readTitleHistories(projectId)),
      writeGlobal: (id, document) => this.writePersistence(() => persistence.writeGlobal(id, document)),
      writeProject: (projectId, document, histories) => this.writePersistence(() => persistence.writeProject(projectId, document, histories)),
    };
    this.options = { ...options, threadStateStore: ownedPersistence };
    this.threadObservations = new WorkbenchThreadObservationController((connectionId, snapshot) => this.options.publish(connectionId, snapshot));
    this.now = options.now ?? Date.now;
    this.archives = new WorkbenchThreadArchiveController({
      now: this.now,
      readNextActivity: () => ownedPersistence.readNextArchiveEligibility(),
      expire: async activeBefore => {
        const eligible = await ownedPersistence.readArchiveEligible(activeBefore);
        for (const projectId of new Set(eligible.map(item => item.projectId))) {
          if (!this.active) return;
          const state = await this.getProject(projectId);
          await this.enqueue(`${projectId}:archive`, async () => {
            const previous = new Map(state.entries);
            if (!this.active || !this.synchronizeSettlementTimestamps(state)) return;
            try {
              await this.persist(projectId, state, this.changedEntryKeys(previous, state), { previousEntries: previous });
              this.publish(projectId, state);
            } catch (error) {
              state.error = `thread-archive: ${sanitizeError(error)}`;
              state.freshness = "partial";
              this.publish(projectId, state);
              throw error;
            }
          });
        }
      },
      onError: error => this.options.log?.(`Thread archival failed: ${sanitizeError(error)}`),
    });
    this.homeDisplayOrder = new WorkbenchHomeThreadDisplayOrderStore(ownedPersistence, {
      reportRepairs: (repairedPaths) => this.logHomeDisplayOrderRepairs(repairedPaths),
    });
    this.pinnedLayout = new WorkbenchPinnedThreadLayoutStore(ownedPersistence, {
      reportRepairs: (repairedPaths) => this.logPinnedLayoutRepairs(repairedPaths),
    });
    this.stopReloadDirtSubscription = options.subscribeReloadDirt?.(() => this.publishReloadDirt()) ?? null;
  }

  subscribe(listener: (projectId: ProjectId, entry: WorkbenchThreadSidebarEntry) => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  async handleRequest(connectionId: string, input: WorkbenchThreadStateRequest | object) {
    this.assertActive();
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
      const observation = this.connectionProjects.get(connectionId);
      const observedProjectId = observation?.scope === "project" ? observation.projectId : "";
      if (!observedProjectId || observedProjectId !== projectRequest.data.projectId) {
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
      case "workbench/thread-state/observe": {
        const observationRequest: ThreadObservationRequest = { projectId: request.projectId, subscriptionId: request.subscriptionId, target: request.target };
        const observation = await this.threadObservations.observe(connectionId, observationRequest, async () => {
          const state = await this.getProject(request.projectId);
          const context = this.selectThreadContext(request.projectId, request.target, state, !this.isObservedProjectAuthorized(connectionId, request.projectId));
          if (!context) throw new Error("The thread is not available through this connection's project or pinned threads.");
          return this.threadObservationSnapshot(observationRequest, state);
        });
        return { result: { observation } };
      }
      case "workbench/thread-state/release":
        this.threadObservations.release(connectionId, request.subscriptionId);
        return { result: { accepted: true } };
      case "workbench/thread-state/open": return { result: await this.open(connectionId, request.projectId, request.version ?? 1) };
      case "workbench/thread-state/global/open": return { result: await this.openGlobal(connectionId, request.version) };
      case "workbench/thread-state/global/close": await this.closeGlobal(connectionId); return { result: { accepted: true } };
      case "workbench/thread-state/close": await this.close(connectionId, request.projectId); return { result: { accepted: true } };
      case "workbench/thread-state/refresh": {
        const sidebar = await this.refresh(request.projectId);
        const observation = this.connectionProjects.get(connectionId);
        return {
          result: observation
            ? this.snapshotForObservation(sidebar, observation)
            : sidebar,
        };
      }
      case "workbench/thread-state/pin/open": {
        const context = await this.getPinnedThreadContext(request);
        if (context) this.authorizePinnedThreadContext(connectionId, context);
        return { result: { context } };
      }
      case "workbench/thread-state/intent/accept": return { result: await this.acceptIntent(connectionId, {
        draftId: request.draftId,
        harness: request.identity.harness,
        projectId: request.projectId,
        threadId: request.identity.threadId,
        title: request.title,
        turnId: request.turnId,
      }) };
      case "workbench/thread-state/title/set":
      case "workbench/thread-state/title/dismiss": {
        if (
          !this.isObservedProjectAuthorized(connectionId, request.projectId)
          && !this.isPinnedThreadAuthorized(connectionId, request.projectId, request.identity.harness, request.identity.threadId)
        ) {
          return { error: { code: "invalidProjectObservation", message: "The title request does not belong to this connection's observed project." } };
        }
        try {
          return { result: request.method === "workbench/thread-state/title/set"
            ? await this.renameThread(request)
            : await this.dismissTitle(request) };
        } catch (error) {
          return { error: { code: "threadTitleMutationFailed", message: sanitizeError(error) } };
        }
      }
      case "workbench/thread-state/draft/upsert": return { result: await this.upsertDraft(request.projectId, request.draft, request.folderId) };
      case "workbench/thread-state/draft/move": return { result: await this.moveDraft(request.sourceProjectId, request.destinationProjectId, request.draftId) };
      case "workbench/thread-state/draft/delete": return { result: await this.deleteDraft(request.projectId, request.draftId, request.clientUpdatedAt) };
      case "workbench/thread-state/draft/pin/set":
      case "workbench/thread-state/draft/snooze/set": return { result: await this.mutateDraft(request) };
      case "workbench/thread-state/priority/set": return { result: await this.mutatePriority(request) };
      case "workbench/thread-state/snooze/until": return { result: await this.mutateDependentSnooze(request) };
      case "workbench/thread-state/display-order/folder/create":
      case "workbench/thread-state/display-order/folder/drop":
      case "workbench/thread-state/display-order/folder/title/set":
      case "workbench/thread-state/display-order/move": return { result: await this.mutateDisplayOrder(request) };
      case "workbench/thread-state/home-display-order/move": return { result: await this.mutateHomeDisplayOrder(connectionId, request) };
      case "workbench/thread-state/pinned-display-order/folder/create":
      case "workbench/thread-state/pinned-display-order/folder/drop":
      case "workbench/thread-state/pinned-display-order/folder/title/set":
      case "workbench/thread-state/pinned-display-order/move": return { result: await this.mutatePinnedDisplayOrder(request) };
      default: return { result: await this.mutateThread(request) };
    }
  }

  async open(connectionId: string, projectId: ProjectId): Promise<WorkbenchThreadStateOpenResultV2>;
  async open(connectionId: string, projectId: ProjectId, version: 5): Promise<WorkbenchThreadStateOpenResult>;
  async open(connectionId: string, projectId: ProjectId, version: 4): Promise<WorkbenchThreadStateOpenResult>;
  async open(connectionId: string, projectId: ProjectId, version: 3): Promise<WorkbenchThreadStateOpenResult>;
  async open(connectionId: string, projectId: ProjectId, version: 2): Promise<WorkbenchThreadStateOpenResultV2>;
  async open(connectionId: string, projectId: ProjectId, version: 1): Promise<WorkbenchThreadSidebarSnapshot>;
  async open(connectionId: string, projectId: ProjectId, version: 1 | 2 | 3 | 4 | 5): Promise<WorkbenchThreadSidebarSnapshot | WorkbenchThreadStateOpenResultV2 | WorkbenchThreadStateOpenResult>;
  async open(connectionId: string, projectId: ProjectId, version: 1 | 2 | 3 | 4 | 5 = 2): Promise<WorkbenchThreadSidebarSnapshot | WorkbenchThreadStateOpenResultV2 | WorkbenchThreadStateOpenResult> {
    const priorObservation = this.connectionProjects.get(connectionId);
    if (priorObservation?.scope === "global") await this.closeGlobal(connectionId);
    const priorProjectId = priorObservation?.scope === "project" ? priorObservation.projectId : "";
    if (priorProjectId && priorProjectId !== projectId) await this.close(connectionId, priorProjectId);
    const state = await this.getProject(projectId);
    const observation: ProjectObservation = { pinnedThreadKeys: new Set(), projectId, scope: "project", version };
    this.startProjectObservation(projectId, state);
    this.connectionProjects.set(connectionId, observation);
    state.observers.add(connectionId);
    const currentProjectUpdate = this.options.projectState.getCurrentUpdate(projectId);
    if (currentProjectUpdate) {
      this.options.publish(connectionId, currentProjectUpdate);
      this.options.log?.(`project replayed connection=${sanitizeLogValue(connectionId)} project=${sanitizeLogValue(projectId)} revision=${currentProjectUpdate.revision}`);
    }
    const sidebar = this.snapshotForObservation(this.snapshot(projectId, state), observation);
    if (version === 1) return sidebar;
    const catalog = this.options.getProjectCatalog();
    const composite = {
      catalog,
      project: currentProjectUpdate ?? this.options.projectState.getCurrentUpdate(projectId),
      sidebar,
    };
    if (version === 2) return composite;
    const loadedProjectSummaries = catalog.data.flatMap(({ id }) => {
      const loadedState = this.projects.get(id);
      return loadedState
        ? [createWorkbenchProjectThreadSummary(id, this.naturallyOrderedEntries(loadedState), loadedState.revision, loadedState.displayOrder)]
        : [];
    });
    this.hydrateProjectThreadSummaries(
      connectionId,
      observation,
      catalog.data.map(({ id }) => id).filter((id) => !this.projects.has(id)),
    );
    return {
      ...composite,
      pinnedThreadLayout: await this.pinnedLayout.getSnapshot(),
      projectThreads: { projects: loadedProjectSummaries },
    };
  }

  async openGlobal(connectionId: string, version: 4 | 5 | 6 | 7 = 5): Promise<WorkbenchGlobalThreadStateOpenResult> {
    const priorObservation = this.connectionProjects.get(connectionId);
    if (priorObservation?.scope === "project") await this.close(connectionId, priorObservation.projectId);
    else if (priorObservation) await this.closeGlobal(connectionId);
    const observation: ProjectObservation = { pinnedThreadKeys: new Set(), scope: "global", version };
    this.connectionProjects.set(connectionId, observation);
    const catalog = this.options.getProjectCatalog();
    const projectSidebars = await Promise.all(catalog.data.map(async ({ id }) => (
      this.snapshotForObservation(this.snapshot(id, await this.getProject(id)), observation)
    )));
    const result = {
      catalog,
      pinnedThreadLayout: await this.pinnedLayout.getSnapshot(),
      projectSidebars: { projects: projectSidebars },
    };
    return version !== 4
      ? { ...result, homeThreadDisplayOrder: await this.homeDisplayOrder.getSnapshot(), version }
      : result;
  }

  async close(connectionId: string, expectedProjectId?: ProjectId) {
    const observation = this.connectionProjects.get(connectionId);
    const projectId = observation?.scope === "project" ? observation.projectId : "";
    if (!projectId || (expectedProjectId && projectId !== expectedProjectId)) return;
    this.connectionProjects.delete(connectionId);
    const state = this.projects.get(projectId);
    if (!state) return;
    state.observers.delete(connectionId);
    this.stopProjectObservationIfIdle(state);
  }

  private async closeGlobal(connectionId: string) {
    if (this.connectionProjects.get(connectionId)?.scope !== "global") return;
    this.connectionProjects.delete(connectionId);
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
      const timed = { ...entry, gitHistoryCleanedAt, settledAt };
      const archive = this.archives.isDue(timed);
      if (entry.settledAt === settledAt && entry.gitHistoryCleanedAt === gitHistoryCleanedAt && !archive) continue;
      state.entries.set(key, archive && timed.entryKind === "thread"
        ? { ...timed, metadata: { archived: true, pinned: false, snoozed: false }, snoozedUntil: null }
        : timed);
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

  async disconnect(connectionId: string) {
    this.threadObservations.disconnect(connectionId);
    if (this.connectionProjects.get(connectionId)?.scope === "global") await this.closeGlobal(connectionId);
    else await this.close(connectionId);
  }

  async acceptIntent(connectionId: string, input: { draftId?: DraftId; harness: "codex" | "copilot" | "opencode"; projectId: ProjectId; threadId: WorkbenchThreadId; title?: string; turnId: WorkbenchTurnId }) {
    const authorizedThreadId = input.draftId ? `draft:${input.draftId}` : input.threadId;
    if (
      !this.isObservedProjectAuthorized(connectionId, input.projectId)
      && !this.isPinnedThreadAuthorized(connectionId, input.projectId, input.harness, authorizedThreadId)
    ) {
      throw new Error("The accepted intent does not belong to this connection's observed or pinned thread project.");
    }
    let draftPinned = false;
    let profile: WorkbenchComposerProfileSelectionState | null = null;
    if (input.draftId) {
      const state = await this.getProject(input.projectId);
      const draftKey = getThreadDisplayDraftKey(input.draftId);
      const draftEntry = state.entries.get(draftKey);
      draftPinned = draftEntry?.entryKind === "draft" ? draftEntry.metadata.pinned : false;
      const draft = state.drafts.get(input.draftId);
      profile = draft ? this.profileFromDraft(draft) : null;
      state.displayOrder = replaceWorkbenchThreadFolderMember(state.displayOrder, draftKey, `${input.harness}:${input.threadId}`);
      const pinnedLayoutUpdate = await this.pinnedLayout.replace(input.projectId, draftKey, getThreadDisplayThreadKey(input.harness, input.threadId));
      if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
      const homeDisplayOrderUpdate = await this.homeDisplayOrder.replace(input.projectId, draftKey, getThreadDisplayThreadKey(input.harness, input.threadId));
      if (homeDisplayOrderUpdate) this.publishHomeDisplayOrder(homeDisplayOrderUpdate);
      state.drafts.delete(input.draftId);
      state.entries.delete(draftKey);
    }
    const acceptedAt = this.now();
    const providerEntry: WorkbenchThreadSidebarEntry = {
      activityAt: acceptedAt, entryKind: "thread", identity: { harness: input.harness, threadId: input.threadId },
      lifecycle: { agent: { agentStatus: "working", turnId: input.turnId }, kind: "working", reason: "acceptedIntent", settled: false },
      metadata: { archived: false, pinned: draftPinned, snoozed: false }, orderAt: acceptedAt, title: input.title?.trim() || input.threadId,
    };
    const entry = await this.applyLifecycle(input.projectId, input.harness, input.threadId, { kind: "acceptedIntent", turnId: input.turnId }, providerEntry, undefined, profile, input.draftId);
    if (!entry) throw new Error("The accepted intent does not identify a known provider thread.");
    return { accepted: true, revision: (await this.getSnapshot(input.projectId)).revision };
  }

  async reportRecoveryFailed(projectId: ProjectId, harness: "codex" | "copilot" | "opencode", threadId: WorkbenchThreadId) {
    return await this.applyLifecycle(projectId, harness, threadId, { kind: "recoveryFailed" });
  }

  async refresh(projectId: ProjectId) {
    const state = await this.getProject(projectId);
    void this.reconcile(projectId, state);
    return this.snapshot(projectId, state);
  }

  async ensureProviderEntry(projectId: ProjectId, providerEntry: Exclude<WorkbenchObservedThreadEntry, { entryKind: "draft" }>) {
    const state = await this.getProject(projectId);
    const key = entryKey(providerEntry);
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const existing = state.entries.get(key);
      // Raw provider reads cannot classify Workbench parent-child ownership.
      if (existing?.entryKind === "subagent" && providerEntry.entryKind === "thread") return existing;
      const previousEntries = new Map(state.entries);
      const changed = this.installProviderSnapshot(state, providerEntry.identity.harness, [providerEntry], { complete: false });
      if (changed) await this.persist(projectId, state, [key], { previousEntries });
      const entry = state.entries.get(key);
      return entry?.entryKind === "draft" ? null : entry ?? null;
    });
  }

  async getMcpGeneration(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId) {
    const state = await this.getProject(projectId);
    const entry = state.entries.get(`${harness}:${threadId}`);
    return entry?.entryKind === "draft" ? null : entry?.mcpGeneration ?? null;
  }

  async setMcpGeneration(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId, generation: string) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    return await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") throw new Error("The managed thread is not present in internal thread state.");
      if (entry.mcpGeneration === generation) return entry;
      const next = parseWorkbenchThreadStateEntry({ ...entry, mcpGeneration: generation });
      if (next.entryKind === "draft") throw new Error("MCP generation cannot be stored on a draft.");
      state.entries.set(key, next);
      await this.persist(projectId, state, [key]);
      return next;
    });
  }

  readComposerProfileTarget(slot: WorkbenchComposerProfileSlot): Promise<WorkbenchComposerProfileTargetSelection | null> {
    const key = `${slot.projectId}:profiles`;
    const pending = this.operationQueues.get(key);
    return this.enqueue(key, async () => {
      await pending;
      return await this.resolveComposerProfileTarget(await this.getProject(slot.projectId), slot);
    });
  }

  setComposerProfileTarget(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection) {
    const parsed = WorkbenchComposerProfileSelectionSchema.parse(selection);
    return this.enqueue(`${slot.projectId}:profiles`, async () => {
      return await this.persistComposerProfileTarget(await this.getProject(slot.projectId), slot, parsed);
    });
  }

  prepareComposerProfileTarget(slot: Extract<WorkbenchComposerProfileSlot, { kind: "thread" }>) {
    const key = `${slot.projectId}:profiles`;
    const pending = this.operationQueues.get(key);
    return this.enqueue(key, async () => {
      await pending;
      const state = await this.getProject(slot.projectId);
      const selection = await this.resolveComposerProfileTarget(state, slot);
      if (!selection) throw new Error("The thread has no available daemon composer profile.");
      if (!await this.persistComposerProfileTarget(state, slot, selection)) throw new Error("The composer profile target no longer exists.");
      const entry = state.entries.get(`${slot.harness}:${slot.threadId}`);
      return { selection, subagentName: entry?.entryKind === "subagent" ? entry.name : null };
    });
  }

  private async resolveComposerProfileTarget(state: ProjectState, slot: WorkbenchComposerProfileSlot): Promise<WorkbenchComposerProfileTargetSelection | null> {
    const entry = slot.kind === "thread" ? state.entries.get(`${slot.harness}:${slot.threadId}`) : null;
    const draft = slot.kind === "draft" ? state.drafts.get(slot.draftId) : null;
    if (slot.kind === "thread" && (!entry || entry.entryKind === "draft")) return null;
    if (slot.kind === "draft" && (!draft || draft.composerSettings.harness !== slot.harness)) return null;
    let selection = slot.kind === "new-thread" ? state.newThreadProfile
      : draft ? this.profileFromDraft(draft)
        : entry && entry.entryKind !== "draft" ? entry.profile ?? (entry.entryKind === "thread" ? state.newThreadProfile : null)
          : null;
    const profileId = selection?.kind === "profile" ? selection.profileId
      : !selection && entry?.entryKind === "subagent" ? entry.profileId : null;
    if (profileId) {
      if (!this.options.readComposerProfiles) throw new Error("The daemon composer profile catalogue is unavailable.");
      const profile = (await this.options.readComposerProfiles()).profiles.find((candidate) => candidate.id === profileId);
      if (profile) {
        const { agentPath, agentSource, harness, model, reasoningEffort, serviceTier } = profile;
        selection = { kind: "profile", profileId, settings: { agentPath, agentSource, harness, model, reasoningEffort, serviceTier } };
      } else if (selection) {
        selection = { kind: "custom", settings: selection.settings };
      }
    }
    if (!selection || !selection.settings.model.trim()) return null;
    if (slot.kind !== "new-thread" && selection.settings.harness !== slot.harness) {
      throw new Error("The daemon composer profile harness does not match the thread.");
    }
    return WorkbenchComposerProfileSelectionSchema.parse(selection);
  }

  private installComposerProfileTarget(state: ProjectState, slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection) {
    if (slot.kind === "new-thread") {
      state.newThreadProfile = selection;
    } else if (slot.kind === "draft") {
      const draft = state.drafts.get(slot.draftId);
      if (!draft || draft.composerSettings.harness !== slot.harness || selection.settings.harness !== slot.harness) return false;
      const next = {
        ...draft, composerSettings: selection.settings,
        profileId: selection.kind === "profile" ? selection.profileId : null,
      };
      state.drafts.set(slot.draftId, next);
      const entry = state.entries.get(`draft:${slot.draftId}`);
      state.entries.set(`draft:${slot.draftId}`, this.draftEntry(next, entry?.entryKind === "draft" ? entry.metadata : undefined));
      state.newThreadProfile = selection;
    } else {
      const key = `${slot.harness}:${slot.threadId}`;
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft" || selection.settings.harness !== slot.harness) return false;
      state.entries.set(key, { ...entry, profile: selection });
    }
    return true;
  }

  private persistComposerProfileTarget(state: ProjectState, slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection) {
    return this.enqueue(`${slot.projectId}:storage:write`, async () => {
      // Stage only profile mutations: other queued writes must never observe an unacknowledged selection.
      const staged = { ...state, drafts: new Map(state.drafts), entries: new Map(state.entries) };
      if (!this.installComposerProfileTarget(staged, slot, selection)) return false;
      await this.writeSelectedState(slot.projectId, staged,
        slot.kind === "thread" ? [`${slot.harness}:${slot.threadId}`]
          : slot.kind === "draft" ? [getThreadDisplayDraftKey(slot.draftId)] : [],
        { profile: slot.kind !== "thread" });
      this.installComposerProfileTarget(state, slot, selection);
      this.publish(slot.projectId, state);
      return true;
    });
  }

  async applyLifecycle(
    projectId: ProjectId,
    harness: "codex" | "copilot" | "opencode",
    threadId: WorkbenchThreadId,
    event: WorkbenchLifecycleEvent,
    providerEntry?: WorkbenchObservedThreadEntry,
    questionnaireMutation?: QuestionnaireStateMutation,
    profile?: WorkbenchComposerProfileSelectionState | null,
    promotedDraftId?: DraftId,
  ) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    const result = await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const beforePublication = new Map(state.entries);
      const wakeReadyBefore = areAllUnsnoozedThreadEntriesSettlementReady(this.naturallyOrderedEntries(state));
      if (!state.entries.has(key) && providerEntry?.entryKind === "thread" && entryKey(providerEntry) === key) {
        const { namedTitle, ...sidebarEntry } = providerEntry;
        state.entries.set(key, parseWorkbenchThreadStateEntry({
          ...sidebarEntry, mcpGeneration: null, providerObserved: true,
          titleHistory: recordThreadTitle([], "", namedTitle ?? "", this.now()),
        }));
      }
      const existing = state.entries.get(key);
      if (!existing || existing.entryKind === "draft") return null;
      const ownedEvent = existing.entryKind === "subagent" && event.kind === "turnCompleted" && event.status === "completed"
        ? { kind: "agentStatus" as const, status: "completed" as const, turnId: event.turnId }
        : event;
      const retainedQuestionnaire = existing.entryKind === "thread"
        && existing.lifecycle.kind === "needsAttention"
        && existing.pendingQuestionnaire?.turnId === (event.kind === "turnCompleted" ? event.turnId : null)
        && event.kind === "turnCompleted" && event.status === "interrupted";
      const lifecycle = retainedQuestionnaire ? existing.lifecycle : reduceWorkbenchThreadLifecycle(existing.lifecycle, ownedEvent);
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
        ? { ...existing, activityAt, lifecycle, ...(event.kind === "acceptedIntent" && profile && !existing.profile ? { profile } : {}) }
        : {
          ...existing,
          activityAt,
          lifecycle,
          ...(event.kind === "acceptedIntent" && !existing.profile ? { profile: profile ?? (existing.entryKind === "thread" ? state.newThreadProfile : null) } : {}),
          metadata: existing.metadata.archived
            ? { archived: true as const, pinned: false as const, snoozed: false as const }
            : { ...existing.metadata, snoozed: shouldUnsnooze ? false : existing.metadata.snoozed },
          ...(event.kind === "acceptedIntent" ? { orderAt: providerEntry?.entryKind === "thread" ? providerEntry.orderAt ?? activityAt : activityAt } : {}),
          snoozedUntil: shouldUnsnooze ? null : existing.snoozedUntil,
          ...(event.kind === "acceptedIntent" && providerEntry?.entryKind === "thread" ? {
            title: resolveWorkbenchThreadTitle({ id: threadId, name: existing.title, preview: providerEntry.title }),
          } : {}),
        };
      const next = questionnaireMutation?.kind === "set"
        ? { ...lifecycleEntry, pendingQuestionnaire: questionnaireMutation.questionnaire }
        : shouldClearQuestionnaire
          ? { ...lifecycleEntry, pendingQuestionnaire: null }
          : lifecycleEntry;
      const parsedNext = parseWorkbenchThreadStateEntry({
        ...next,
        titleHistory: recordThreadTitle(existing.titleHistory ?? [], existing.title, providerEntry?.namedTitle ?? "", this.now()),
      });
      if (parsedNext.entryKind === "draft") throw new Error("Lifecycle transitions cannot produce draft entries.");
      state.entries.set(key, parsedNext);
      if (!wakeReadyBefore && areAllUnsnoozedThreadEntriesSettlementReady(this.naturallyOrderedEntries(state))) {
        const snapshot = this.snapshot(projectId, state);
        const highestSnoozed = snapshot.entries.find((candidate) => (
          getThreadSidebarGroup(candidate) === "snoozed"
          && !findWorkbenchThreadFolder(snapshot.displayOrder, getWorkbenchThreadDisplayKey(candidate))
          && (() => {
            const record = state.entries.get(getWorkbenchThreadDisplayKey(candidate));
            return record?.entryKind === "thread" && !record.snoozedUntil;
          })()
        ));
        if (highestSnoozed) {
          const candidateKey = getWorkbenchThreadDisplayKey(highestSnoozed);
          const candidate = state.entries.get(candidateKey);
          if (candidate && candidate.entryKind !== "subagent" && !candidate.metadata.archived && candidate.metadata.snoozed) {
            state.entries.set(candidateKey, parseWorkbenchThreadStateEntry({ ...candidate, metadata: { ...candidate.metadata, snoozed: false } }));
          }
        }
      }
      await this.persist(projectId, state, [
        ...this.changedEntryKeys(beforePublication, state),
        ...(promotedDraftId ? [getThreadDisplayDraftKey(promotedDraftId)] : []),
      ], { layout: Boolean(promotedDraftId) });
      this.publish(projectId, state, parsedNext, beforePublication);
      return parsedNext;
    });
    await this.reevaluateDependentSnoozes(projectId, key);
    return result;
  }

  findPendingSidebarQuestionnaire(harness: WorkbenchHarnessId, threadId: WorkbenchThreadId) {
    for (const [projectId, state] of this.projects) {
      const entry = state.entries.get(`${harness}:${threadId}`);
      if (entry?.entryKind === "thread" && !entry.metadata.archived && entry.pendingQuestionnaire) {
        return { projectId, entry, questionnaire: entry.pendingQuestionnaire };
      }
    }
    return null;
  }

  async getThreadEntry(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId) {
    const state = await this.getProject(projectId);
    return this.naturallyOrderedEntries(state).find(entry => entry.entryKind !== "draft"
      && entry.identity.harness === harness && entry.identity.threadId === threadId) ?? null;
  }

  async getRevision(projectId: ProjectId) {
    return (await this.getProject(projectId)).revision;
  }

  async observeLifecycleInProject(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId, event: WorkbenchObservedLifecycleEvent) {
    await this.getProject(projectId);
    return this.observeLifecycle(harness, threadId, event, projectId);
  }

  async observeLifecycle(harness: "codex" | "copilot" | "opencode", threadId: WorkbenchThreadId, event: WorkbenchObservedLifecycleEvent, selectedProjectId?: ProjectId) {
    const key = `${harness}:${threadId}`;
    const projectIds = [...this.projects.entries()].filter(([id, state]) => (!selectedProjectId || id === selectedProjectId) && state.entries.has(key)).map(([projectId]) => projectId);
    let lifecycle: WorkbenchThreadLifecycle | null = null;
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
        const next = await this.applyLifecycle(projectId, harness, threadId, exactEvent, undefined, questionnaireMutation);
        if (next) lifecycle = next.lifecycle;
      } else if (questionnaireMutation) {
        const next = await this.updateQuestionnaireState(projectId, harness, threadId, questionnaireMutation);
        if (next) lifecycle = next.lifecycle;
      }
    }
    return lifecycle;
  }

  private async updateQuestionnaireState(
    projectId: ProjectId,
    harness: WorkbenchHarnessId,
    threadId: WorkbenchThreadId,
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
      await this.persist(projectId, state, [key]);
      this.publish(projectId, state, next);
      return next;
    });
  }

  async observeActivity(harness: "codex" | "copilot" | "opencode", threadId: WorkbenchThreadId, turnStartedAt?: number | null, selectedProjectId?: ProjectId) {
    if (selectedProjectId) await this.getProject(selectedProjectId);
    const key = `${harness}:${threadId}`;
    for (const [projectId, state] of this.projects) {
      if (selectedProjectId && selectedProjectId !== projectId || !state.entries.has(key)) continue;
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
          await this.persist(projectId, state, [key]);
        }
        if (!this.active || (!state.observers.size && !this.threadObservations.hasProject(projectId))) return;
        state.revision += 1;
        this.threadObservations.update(projectId, request => this.threadObservationSnapshot(request, state));
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

  async observeTitle(harness: "codex" | "copilot" | "opencode", threadId: WorkbenchThreadId, title: string) {
    const key = `${harness}:${threadId}`;
    for (const [projectId, state] of this.projects) {
      if (state.entries.has(key)) await this.setTitle(projectId, harness, threadId, title);
    }
  }

  async setTitle(projectId: ProjectId, harness: "codex" | "copilot" | "opencode", threadId: WorkbenchThreadId, title: string) {
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

  private async setTitleOwned(projectId: ProjectId, state: ProjectState, key: string, title: string) {
    const beforePublication = new Map(state.entries);
    const entry = state.entries.get(key);
    if (!entry || entry.entryKind === "draft") return null;
    const next = parseWorkbenchThreadStateEntry({
      ...entry, title, titleHistory: recordThreadTitle(entry.titleHistory ?? [], entry.title, title, this.now()),
    });
    if (next.entryKind === "draft") return null;
    if (areDeeplyEqual(entry, next)) return next;
    state.entries.set(key, next);
    await this.persist(projectId, state, [key]);
    this.publish(projectId, state, state.entries.get(key), beforePublication);
    return next;
  }

  private async dismissTitle(request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/title/dismiss" }>) {
    const state = await this.getProject(request.projectId);
    const key = `${request.identity.harness}:${request.identity.threadId}`;
    return await this.enqueue(`${request.projectId}:thread:${key}`, async () => {
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") throw new Error("The thread is not available in the observed project.");
      if (request.title === entry.title) return { accepted: false };
      const titleHistory = dismissThreadTitle(entry.titleHistory ?? [], entry.title, request.title);
      if (!areDeeplyEqual(titleHistory, entry.titleHistory ?? [])) {
        state.entries.set(key, { ...entry, titleHistory });
        await this.persist(request.projectId, state, [key]);
        this.publish(request.projectId, state, state.entries.get(key));
      }
      return { accepted: true };
    });
  }

  async getSnapshot(projectId: ProjectId) {
    const state = await this.getProject(projectId);
    return this.snapshot(projectId, state);
  }

  async getThreadClaimContext(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId): Promise<WorkbenchThreadClaimContext | null> {
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

  async refreshGitArcState(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId) {
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    const result = await this.enqueue(`${projectId}:thread:${key}`, async () => {
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
      await this.persist(projectId, state, [key]);
      this.publish(projectId, state, next);
      return next;
    });
    await this.reevaluateDependentSnoozes(projectId, key);
    return result;
  }

  async dispose() {
    this.active = false;
    this.threadObservations.dispose();
    this.stopReloadDirtSubscription?.();
    this.waitingByThreadKey.clear();
    for (const state of this.projects.values()) {
      state.generation += 1;
      state.abort?.abort();
      state.stopProjectObservation?.();
      state.stopProjectObservation = null;
    }
    await this.archives.dispose();
    while (this.persistenceWrites.size) await Promise.allSettled([...this.persistenceWrites]);
  }

  private assertActive() {
    if (!this.active) throw this.retiredError;
  }

  private async readPersistence<T>(read: () => Promise<T>) {
    this.assertActive();
    const value = await read();
    this.assertActive();
    return value;
  }

  private async writePersistence(write: () => Promise<void>) {
    this.assertActive();
    const operation = write();
    this.persistenceWrites.add(operation);
    try { await operation; }
    finally { this.persistenceWrites.delete(operation); }
  }

  private async getProject(projectId: ProjectId) {
    this.assertActive();
    const current = this.projects.get(projectId);
    if (current) return current;
    await this.enqueue(`${projectId}:project:load`, async () => {
      if (this.projects.has(projectId)) return;
      const stored = await this.loadProjectStorage(projectId);
      this.assertActive();
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
      const state: ProjectState = { abort: null, displayOrder: stored.displayOrder ?? {}, drafts, entries, error: null, freshness: "loading", generation: 0, newThreadProfile: stored.newThreadProfile, observers: new Set(), reconcilePromise: null, revision: 0, stopProjectObservation: null };
      const originalEntries = new Map(state.entries);
      const repairedSettlementTimestamps = this.synchronizeSettlementTimestamps(state);
      this.projects.set(projectId, state);
      this.updatePinnedLayoutEntries(projectId, this.naturallyOrderedEntries(state));
      const pinnedLayoutUpdate = await this.pinnedLayout.importProject(projectId, this.naturallyOrderedEntries(state), state.displayOrder);
      if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
      if (repairedSettlementTimestamps) await this.persist(projectId, state, this.changedEntryKeys(originalEntries, state), { previousEntries: originalEntries });
      this.archives.reschedule();
      setTimeout(() => {
        if (this.active) void this.reconcile(projectId, state);
      }, 0);
    });
    const loaded = this.projects.get(projectId);
    if (!loaded) throw new Error(`Project state failed to load: ${projectId}`);
    return loaded;
  }

  private startProjectObservation(projectId: ProjectId, state: ProjectState) {
    this.assertActive();
    if (state.stopProjectObservation) return;
    state.stopProjectObservation = this.options.projectState.observe(
      projectId,
      (update) => this.publishUpdate(state, update),
    );
  }

  private stopProjectObservationIfIdle(state: ProjectState) {
    if (state.observers.size || !state.stopProjectObservation) return;
    state.stopProjectObservation();
    state.stopProjectObservation = null;
  }

  private loadProjectStorage(projectId: ProjectId) {
    return this.enqueue(`${projectId}:storage:read`, async (): Promise<StoredProjectState> => {
      const stored = await this.options.threadStateStore.readProject(projectId);
      const decoded = this.decodeStoredProjectState(
        (stored ?? { drafts: [], newThreadProfile: null, records: [], version: 4 }) as Partial<StoredProjectState | StoredProjectStateV3 | StoredProjectStateV2 | StoredProjectStateV1>,
        projectId,
      );
      const histories = new Map((await this.options.threadStateStore.readTitleHistories(projectId))
        .map((history) => [`${history.identity.harness}:${history.identity.threadId}`, history.titles]));
      const records = decoded.records.map((record) => ({
        ...record,
        titleHistory: histories.get(entryKey(record)) ?? [],
      }));
      if (stored === null || !areDeeplyEqual(stored, decoded)) {
        await this.options.threadStateStore.writeProject(projectId, decoded, records.map((record) => ({
          identity: record.identity, titles: record.titleHistory,
        })));
      }
      return { ...decoded, records };
    });
  }

  private async getProjectThreadSummary(projectId: ProjectId) {
    const state = this.projects.get(projectId);
    if (state) {
      return createWorkbenchProjectThreadSummary(projectId, this.naturallyOrderedEntries(state), state.revision, state.displayOrder);
    }
    const stored = await this.loadProjectStorage(projectId);
    const entries: WorkbenchThreadSidebarEntry[] = [
      ...stored.records.flatMap((record) => {
        const projected = projectWorkbenchThreadStateEntry(record);
        return projected ? [projected] : [];
      }),
      ...stored.drafts.map(({ pinned, snoozed, ...draft }) => this.draftEntry(draft, {
        archived: false,
        pinned: pinned === true,
        snoozed: snoozed === true,
      })),
    ];
    this.updatePinnedLayoutEntries(projectId, entries);
    const pinnedLayoutUpdate = await this.pinnedLayout.importProject(projectId, entries, stored.displayOrder ?? {});
    if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
    return createWorkbenchProjectThreadSummary(projectId, entries, 0, stored.displayOrder);
  }

  private async getPinnedThreadContext(
    request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/pin/open" }>,
  ) {
    return this.selectThreadContext(request.projectId, request.target, await this.getProject(request.projectId), true);
  }

  private selectThreadContext(projectId: ProjectId, target: WorkbenchThreadTarget, state: ProjectState, requirePinned: boolean) {
    if (!target || target.kind === "new") return null;
    const entries = this.naturallyOrderedEntries(state);
    if (target.kind === "draft") {
      const draft = entries.find((entry) => (
        entry.entryKind === "draft"
        && entry.draft.draftId === target.draftId
        && (!requirePinned || getThreadSidebarGroup(entry) === "pinned")
      ));
      return draft ? { entries: [draft], projectId, target } : null;
    }

    const rootThreadId = target.kind === "subagent" ? target.parentThreadId : target.threadId;
    const root = entries.find((entry) => (
      entry.entryKind === "thread"
      && entry.identity.threadId === rootThreadId
      && (target.kind === "subagent" || !target.harness || entry.identity.harness === target.harness)
      && (!requirePinned || getThreadSidebarGroup(entry) === "pinned")
    ));
    if (!root || root.entryKind !== "thread") return null;
    const subagents = entries.filter((entry) => (
      entry.entryKind === "subagent"
      && entry.parentThreadId === root.identity.threadId
    ));
    if (target.kind === "subagent") {
      const selectedSubagent = subagents.find((entry) => (
        entry.entryKind === "subagent"
        && entry.identity.threadId === target.threadId
        && (!target.harness || entry.identity.harness === target.harness)
      ));
      if (!selectedSubagent || selectedSubagent.entryKind !== "subagent") return null;
      return {
        entries: [root, ...subagents],
        projectId,
        target: { ...target, harness: selectedSubagent.identity.harness },
      };
    }
    return {
      entries: [root, ...subagents],
      projectId,
      target: { ...target, harness: root.identity.harness },
    };
  }

  private threadObservationSnapshot(request: ThreadObservationRequest, state: ProjectState): WorkbenchThreadObservationSnapshot {
    const context = this.selectThreadContext(request.projectId, request.target.kind === "subagent"
      ? { kind: "provider", threadId: request.target.parentThreadId }
      : request.target, state, false);
    return {
      entries: context?.entries ?? [],
      error: context ? null : state.error?.slice(0, 500) ?? null,
      freshness: context ? "fresh" : state.freshness,
      projectId: request.projectId,
      revision: state.revision,
      subscriptionId: request.subscriptionId,
      target: context?.target.kind === "provider" ? context.target : request.target,
      updateKind: "threadObservation",
      version: 1,
    };
  }

  private authorizePinnedThreadContext(
    connectionId: string,
    context: { entries: WorkbenchThreadSidebarEntry[]; projectId: ProjectId },
  ) {
    const observation = this.connectionProjects.get(connectionId);
    if (!observation) return;
    for (const entry of context.entries) {
      const harness = entry.entryKind === "draft" ? entry.draft.composerSettings.harness : entry.identity.harness;
      const threadId = entry.entryKind === "draft" ? `draft:${entry.draft.draftId}` : entry.identity.threadId;
      observation.pinnedThreadKeys.add(`${context.projectId}\0${harness}\0${threadId}`);
    }
  }

  private isPinnedThreadAuthorized(connectionId: string, projectId: ProjectId, harness: WorkbenchHarnessId, threadId: string) {
    return this.connectionProjects.get(connectionId)?.pinnedThreadKeys.has(`${projectId}\0${harness}\0${threadId}`) === true;
  }

  private isObservedProjectAuthorized(connectionId: string, projectId: ProjectId) {
    const observation = this.connectionProjects.get(connectionId);
    return observation?.scope === "global"
      ? this.options.getProjectCatalog().data.some(({ id }) => id === projectId)
      : observation?.projectId === projectId;
  }

  private hydrateProjectThreadSummaries(
    connectionId: string,
    observation: ProjectObservation,
    projectIds: readonly ProjectId[],
  ) {
    const hydrationPromise = Promise.all(projectIds.map(async (projectId) => {
      try {
        const summary = await this.getProjectThreadSummary(projectId);
        if (!this.active || this.connectionProjects.get(connectionId) !== observation) return;
        this.options.publish(connectionId, { summary, updateKind: "projectThreadSummary" });
      } catch (error) {
        this.options.log?.(`project thread summary hydration failed project=${sanitizeLogValue(projectId)} error=${sanitizeError(error)}`);
      }
    })).then(() => undefined).finally(() => {
      this.summaryHydrationPromises.delete(hydrationPromise);
    });
    this.summaryHydrationPromises.add(hydrationPromise);
  }

  private decodeStoredProjectState(stored: Partial<StoredProjectState | StoredProjectStateV3 | StoredProjectStateV2 | StoredProjectStateV1>, projectId: ProjectId): StoredProjectState {
    const records = (stored.version === 3 || stored.version === 4) && Array.isArray(stored.records)
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
    const storedNewThreadProfile = "newThreadProfile" in stored
      ? WorkbenchComposerProfileSelectionSchema.safeParse(stored.newThreadProfile)
      : null;
    const latestDraft = [...drafts].sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return {
      ...("displayOrder" in stored && !isWorkbenchThreadDisplayOrderEmpty(stored.displayOrder)
        ? { displayOrder: normalizeWorkbenchThreadDisplayOrder(stored.displayOrder) }
        : {}),
      drafts,
      newThreadProfile: storedNewThreadProfile?.success
        ? storedNewThreadProfile.data
        : latestDraft ? this.profileFromDraft(latestDraft) : null,
      records,
      version: 4,
    };
  }

  private draftEntry(draft: WorkbenchThreadDraft, metadata = { archived: false as const, pinned: false, snoozed: false }): Extract<WorkbenchThreadStateEntry, { entryKind: "draft" }> { return { activityAt: draft.updatedAt, draft, entryKind: "draft", metadata, title: draft.prompt.trim().split(/\r?\n/u).find(Boolean)?.trim().replace(/\s+/gu, " ") || "Draft" }; }

  private profileFromDraft(draft: WorkbenchThreadDraft): WorkbenchComposerProfileSelectionState {
    return draft.profileId
      ? { kind: "profile", profileId: draft.profileId, settings: draft.composerSettings }
      : { kind: "custom", settings: draft.composerSettings };
  }
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
  private logPinnedLayoutRepairs(repairedPaths: PropertyKey[][]) {
    if (!repairedPaths.length) return;
    const paths = repairedPaths
      .slice(0, 20)
      .map((repairPath) => repairPath.length ? repairPath.map(sanitizeLogValue).join(".") : "root")
      .join(",");
    this.options.log?.(`Conformed stored pinned thread layout: repairedPaths=${paths || "none"}`);
  }
  private logHomeDisplayOrderRepairs(repairedPaths: PropertyKey[][]) {
    if (!repairedPaths.length) return;
    const paths = repairedPaths
      .slice(0, 20)
      .map((repairPath) => repairPath.length ? repairPath.map(sanitizeLogValue).join(".") : "root")
      .join(",");
    this.options.log?.(`Conformed stored home thread display order: repairedPaths=${paths || "none"}`);
  }
  private snapshot(projectId: ProjectId, state: ProjectState): WorkbenchThreadSidebarSnapshot {
    const naturallyOrdered = this.naturallyOrderedEntries(state);
    const resolved = resolveWorkbenchThreadDisplayOrder(naturallyOrdered, state.displayOrder);
    return {
      ...resolved,
      error: state.error,
      freshness: state.freshness,
      projectId,
      revision: state.revision,
    };
  }
  private snapshotForObservation(
    sidebar: WorkbenchThreadSidebarSnapshot,
    observation: ProjectObservation,
  ): WorkbenchThreadSidebarSnapshot {
    const legacy = observation.scope === "project" ? observation.version <= 3 : observation.version <= 5;
    if (!legacy || !this.options.getReloadDirt) return sidebar;
    const reloadDirt = this.options.getReloadDirt();
    return {
      ...sidebar,
      reloadDirt: {
        ...reloadDirt,
        dirtyScopes: reloadDirt.dirtyScopes.map(({ dependantScopes: _dependantScopes, ...scope }) => scope),
      },
    };
  }
  private publishReloadDirt() {
    if (!this.active) return;
    const legacyGlobalObservers = [...this.connectionProjects.entries()].filter(([, observation]) => (
      observation.scope === "global" && observation.version <= 5
    ));
    for (const [projectId, state] of this.projects) {
      const legacyProjectObservers = [...state.observers].flatMap((connectionId) => {
        const observation = this.connectionProjects.get(connectionId);
        return observation?.scope === "project" && observation.version <= 3 ? [[connectionId, observation] as const] : [];
      });
      if (!legacyProjectObservers.length && !legacyGlobalObservers.length) continue;
      state.revision += 1;
      const sidebar = this.snapshot(projectId, state);
      for (const [connectionId, observation] of legacyProjectObservers) {
        this.options.publish(connectionId, this.snapshotForObservation(sidebar, observation));
      }
      for (const [connectionId, observation] of legacyGlobalObservers) {
        this.options.publish(connectionId, {
          sidebar: this.snapshotForObservation(sidebar, observation),
          updateKind: "projectThreadSidebar",
        });
      }
    }
  }
  private publish(projectId: ProjectId, state: ProjectState, changedEntry?: WorkbenchThreadStateEntry, before?: ReadonlyMap<string, WorkbenchThreadStateEntry>) {
    if (!this.active) return;
    state.revision += 1;
    const entries = this.naturallyOrderedEntries(state);
    this.updatePinnedLayoutEntries(projectId, entries);
    let sidebar: WorkbenchThreadSidebarSnapshot | null = null;
    const fullSidebar = () => sidebar ??= this.snapshot(projectId, state);
    const changed = before ? [...state.entries].filter(([key, entry]) => before.get(key) !== entry).map(([, entry]) => entry) : [];
    const changedKeys = new Set(changed.map(entryKey));
    const parents = new Set(changed.flatMap(entry => entry.entryKind === "subagent" ? [entry.parentThreadId] : []));
    const upserts = entries.filter(entry => changedKeys.has(entryKey(entry))
      || entry.entryKind === "thread" && parents.has(entry.identity.threadId));
    const projectedKeys = new Set(upserts.map(entryKey));
    const delta: WorkbenchThreadStateDelta | null = before ? {
      updateKind: "threadStateDelta", projectId, revision: state.revision,
      upserts,
      removedKeys: [...new Set([
        ...[...before.keys()].filter(key => !state.entries.has(key)),
        ...[...changedKeys].filter(key => !projectedKeys.has(key)),
      ])],
      displayOrder: state.displayOrder, error: state.error, freshness: state.freshness,
    } : null;
    this.threadObservations.update(projectId, request => this.threadObservationSnapshot(request, state));
    const summary = createWorkbenchProjectThreadSummary(projectId, entries, state.revision, state.displayOrder);
    for (const [connectionId, observation] of this.connectionProjects) {
      if (observation.scope === "project") {
        if (observation.projectId === projectId) {
          this.options.publish(connectionId, delta && observation.version >= 5
            ? delta : this.snapshotForObservation(fullSidebar(), observation));
        }
        if (observation.version >= 3) this.options.publish(connectionId, { summary, updateKind: "projectThreadSummary" });
      } else {
        this.options.publish(connectionId, delta && observation.version >= 7 ? delta : {
          sidebar: this.snapshotForObservation(fullSidebar(), observation), updateKind: "projectThreadSidebar",
        });
      }
    }
    const projected = changedEntry ? projectWorkbenchThreadStateEntry(changedEntry) : null;
    if (projected) for (const listener of this.subscribers) listener(projectId, projected);
  }

  private publishUpdate(state: ProjectState, update: WorkbenchThreadStateSnapshot) {
    if (!this.active) return;
    for (const connectionId of state.observers) {
      const observation = this.connectionProjects.get(connectionId);
      this.options.publish(
        connectionId,
        observation && !("updateKind" in update)
          ? this.snapshotForObservation(update, observation)
          : update,
      );
    }
  }

  private reconcile(projectId: ProjectId, state: ProjectState) {
    if (state.reconcilePromise) return state.reconcilePromise;
    const generation = ++state.generation;
    const abort = new AbortController();
    state.abort?.abort();
    state.abort = abort;
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
            if (cleaned) await this.persist(projectId, state, expiredRecords.map(record => record.key));
          } catch (error) {
            retentionFailure = `git-retention: ${sanitizeError(error)}`;
            this.options.log?.(`Git retention failed project=${sanitizeLogValue(projectId)} error=${sanitizeError(error)}`);
          }
        }
        const failures = await this.options.reconcileProject(projectId, abort.signal, async (harness, entries, options) => {
          if (!this.active || generation !== state.generation) return;
          const previousEntries = new Map(state.entries);
          if (this.installProviderSnapshot(state, harness, entries, options)) {
            await this.persist(projectId, state, this.changedEntryKeys(previousEntries, state), { previousEntries });
          }
          if (!this.active || generation !== state.generation) return;
          state.error = null;
          state.freshness = "partial";
          this.publish(projectId, state);
        }, async (snapshot) => {
          if (!this.active || generation !== state.generation) return;
          const previousEntries = new Map(state.entries);
          if (!this.installGitArcSnapshot(state, snapshot)) return;
          await this.persist(projectId, state, this.changedEntryKeys(previousEntries, state), { previousEntries });
          if (!this.active || generation !== state.generation) return;
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
        if (state.freshness === "fresh") {
          await this.reevaluateAllDependentSnoozes();
        }
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
    entries: WorkbenchObservedThreadEntry[],
    { complete }: { complete: boolean },
  ) {
    let changed = false;
    const install = (key: string, entry: WorkbenchThreadStateEntry, namedTitle?: string) => {
      const existing = state.entries.get(key);
      if (entry.entryKind !== "draft") {
        entry = {
          ...entry,
          titleHistory: recordThreadTitle(
            existing && existing.entryKind !== "draft" ? existing.titleHistory ?? [] : [],
            existing?.title ?? "",
            namedTitle ?? "",
            this.now(),
          ),
        };
      }
      if (areDeeplyEqual(state.entries.get(key), entry)) return;
      state.entries.set(key, entry);
      changed = true;
    };
    const providerKeys = new Set<string>();
    for (const candidate of entries) {
      const { namedTitle, ...sidebarEntry } = candidate;
      const parsed = WorkbenchThreadSidebarEntrySchema.safeParse(sidebarEntry);
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
          profile: existing.profile,
          ...(existing.pendingQuestionnaire ? { pendingQuestionnaire: existing.pendingQuestionnaire } : {}),
          pinned: existing.entryKind === "subagent" ? existing.pinned : existing.metadata.pinned,
          providerObserved: true,
          settledAt: existing.settledAt,
          snoozedUntil: existing.snoozedUntil,
          ...(existing.questionnaireHistory?.length ? { questionnaireHistory: existing.questionnaireHistory } : {}),
        } : { ...providerEntry, mcpGeneration: null, providerObserved: true }), namedTitle);
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
        profile: existing.profile,
        metadata,
        ...(existing.entryKind === "thread" && existing.orderAt !== undefined ? { orderAt: existing.orderAt } : {}),
        ...(existing.pendingQuestionnaire ? { pendingQuestionnaire: existing.pendingQuestionnaire } : {}),
        providerObserved: true,
        settledAt: existing.settledAt,
        snoozedUntil: existing.snoozedUntil,
        ...(existing.questionnaireHistory?.length ? { questionnaireHistory: existing.questionnaireHistory } : {}),
        title: providerEntry.title === "New thread" ? existing.title : providerEntry.title,
      } : { ...providerEntry, mcpGeneration: null, providerObserved: true }), namedTitle);
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

  private publishPinnedLayout(snapshot: Extract<WorkbenchThreadStateSnapshot, { updateKind: "pinnedThreadLayout" }>) {
    if (!this.active) return;
    for (const [connectionId, observation] of this.connectionProjects) {
      if (
        (observation.scope === "project" && observation.version >= 3)
        || observation.scope === "global"
      ) this.options.publish(connectionId, snapshot);
    }
  }

  private publishHomeDisplayOrder(snapshot: Extract<WorkbenchThreadStateSnapshot, { updateKind: "homeThreadDisplayOrder" }>) {
    if (!this.active) return;
    for (const [connectionId, observation] of this.connectionProjects) {
      if (observation.scope === "global" && observation.version >= 5) this.options.publish(connectionId, snapshot);
    }
  }

  private homeLayoutEntries() {
    return [...this.projects].flatMap(([projectId, state]) => this.naturallyOrderedEntries(state).flatMap((entry): ThreadDisplayLayoutEntry<ProjectThreadDisplayKey>[] => {
      const section = getWorkbenchThreadDisplaySection(entry);
      return section ? [{ key: getWorkbenchHomeThreadKey(projectId, entry), section }] : [];
    }));
  }

  private updatePinnedLayoutEntries(projectId: ProjectId, entries: readonly WorkbenchThreadSidebarEntry[]) {
    const prefix = `${encodeURIComponent(projectId)}/`;
    for (const key of this.pinnedEntries.keys()) {
      if (key.startsWith(prefix)) this.pinnedEntries.delete(key);
    }
    for (const entry of entries) {
      if (getThreadSidebarGroup(entry) !== "pinned") continue;
      this.pinnedEntries.set(getProjectQualifiedThreadDisplayKey(projectId, getWorkbenchThreadDisplayKey(entry)), {
        key: getProjectQualifiedThreadDisplayKey(projectId, getWorkbenchThreadDisplayKey(entry)),
        section: "pinned",
      });
    }
  }

  private async mutatePinnedDisplayOrder(
    request: Extract<WorkbenchThreadStateRequest, {
      method:
        | "workbench/thread-state/pinned-display-order/folder/create"
        | "workbench/thread-state/pinned-display-order/folder/drop"
        | "workbench/thread-state/pinned-display-order/folder/title/set"
        | "workbench/thread-state/pinned-display-order/move";
    }>,
  ) {
    if (request.method === "workbench/thread-state/pinned-display-order/folder/drop") {
      return await this.mutatePinnedFolderDrop(request);
    }
    if (request.method === "workbench/thread-state/pinned-display-order/move" && !request.sourceKey.startsWith("folder:")) {
      return await this.mutatePinnedThreadMove(request);
    }
    if ("sourceKey" in request && !request.sourceKey.startsWith("folder:")) {
      const identity = parseProjectQualifiedThreadDisplayKey(request.sourceKey);
      if (!identity) return { accepted: false, revision: (await this.pinnedLayout.getSnapshot()).revision };
      if (!this.pinnedEntries.has(request.sourceKey)) {
        const state = await this.getProject(identity.projectId);
        this.updatePinnedLayoutEntries(identity.projectId, this.naturallyOrderedEntries(state));
      }
    }
    const result = await this.pinnedLayout.mutate([...this.pinnedEntries.values()], request);
    if (result.snapshot) this.publishPinnedLayout(result.snapshot);
    return { accepted: result.accepted, revision: result.snapshot?.revision ?? (await this.pinnedLayout.getSnapshot()).revision };
  }

  private async mutatePinnedThreadMove(
    request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/pinned-display-order/move" }>,
  ) {
    const sourceIdentity = parseProjectQualifiedThreadDisplayKey(request.sourceKey);
    const currentSnapshot = await this.pinnedLayout.getSnapshot();
    if (!sourceIdentity || sourceIdentity.threadKey.startsWith("folder:")) {
      return { accepted: false, revision: currentSnapshot.revision };
    }
    const sourceState = await this.getProject(sourceIdentity.projectId);
    return await this.enqueue("pinned-display-order", async () => await this.enqueue(
      `${sourceIdentity.projectId}:thread:${sourceIdentity.threadKey}`,
      async () => {
        const source = sourceState.entries.get(sourceIdentity.threadKey);
        if (!source) return { accepted: false, revision: (await this.pinnedLayout.getSnapshot()).revision };
        const nextSource = setEntryPriority(source, "pinned");
        if (!nextSource) return { accepted: false, revision: (await this.pinnedLayout.getSnapshot()).revision };
        const priorDisplayOrder = sourceState.displayOrder;
        const sourceChanged = !areDeeplyEqual(source, nextSource);
        if (sourceChanged) {
          sourceState.entries.set(sourceIdentity.threadKey, nextSource);
          sourceState.displayOrder = reconcileWorkbenchThreadDisplayOrder(this.naturallyOrderedEntries(sourceState), sourceState.displayOrder);
          try {
            await this.persist(sourceIdentity.projectId, sourceState, [sourceIdentity.threadKey], { layout: true });
          } catch (error) {
            sourceState.entries.set(sourceIdentity.threadKey, source);
            sourceState.displayOrder = priorDisplayOrder;
            throw error;
          }
        }
        this.updatePinnedLayoutEntries(sourceIdentity.projectId, this.naturallyOrderedEntries(sourceState));
        try {
          const result = await this.pinnedLayout.mutate([...this.pinnedEntries.values()], request);
          if (!result.accepted) {
            if (sourceChanged) {
              sourceState.entries.set(sourceIdentity.threadKey, source);
              sourceState.displayOrder = priorDisplayOrder;
              await this.persist(sourceIdentity.projectId, sourceState, [sourceIdentity.threadKey], { layout: true });
              this.updatePinnedLayoutEntries(sourceIdentity.projectId, this.naturallyOrderedEntries(sourceState));
            }
            return { accepted: false, revision: (await this.pinnedLayout.getSnapshot()).revision };
          }
          if (sourceChanged) this.publish(sourceIdentity.projectId, sourceState, nextSource);
          if (result.snapshot) this.publishPinnedLayout(result.snapshot);
          return { accepted: true, revision: result.snapshot?.revision ?? (await this.pinnedLayout.getSnapshot()).revision };
        } catch (error) {
          if (sourceChanged) {
            sourceState.entries.set(sourceIdentity.threadKey, source);
            sourceState.displayOrder = priorDisplayOrder;
            try {
              await this.persist(sourceIdentity.projectId, sourceState, [sourceIdentity.threadKey], { layout: true });
              this.updatePinnedLayoutEntries(sourceIdentity.projectId, this.naturallyOrderedEntries(sourceState));
            } catch {
              throw new Error(`Pinned thread move failed and source priority rollback could not be persisted: ${sanitizeError(error)}`);
            }
          }
          throw error;
        }
      },
    ));
  }

  private async mutatePinnedFolderDrop(
    request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/pinned-display-order/folder/drop" }>,
  ) {
    const sourceIdentity = parseProjectQualifiedThreadDisplayKey(request.sourceKey);
    const targetIdentity = parseProjectQualifiedThreadDisplayKey(request.targetKey);
    const currentSnapshot = await this.pinnedLayout.getSnapshot();
    if (!sourceIdentity || !targetIdentity || sourceIdentity.threadKey.startsWith("folder:") || targetIdentity.threadKey.startsWith("folder:")) {
      return { accepted: false, revision: currentSnapshot.revision };
    }
    const sourceState = await this.getProject(sourceIdentity.projectId);
    const targetState = await this.getProject(targetIdentity.projectId);
    return await this.enqueue("pinned-display-order", async () => await this.enqueue(
      `${sourceIdentity.projectId}:thread:${sourceIdentity.threadKey}`,
      async () => {
        const source = sourceState.entries.get(sourceIdentity.threadKey);
        const target = targetState.entries.get(targetIdentity.threadKey);
        if (!source || !target || target.entryKind !== "thread" || target.metadata.archived || target.lifecycle.settled) {
          return { accepted: false, revision: (await this.pinnedLayout.getSnapshot()).revision };
        }
        const nextSource = setEntryPriority(source, "pinned");
        if (!nextSource) return { accepted: false, revision: (await this.pinnedLayout.getSnapshot()).revision };
        const priorSource = source;
        const priorDisplayOrder = sourceState.displayOrder;
        const sourceChanged = !areDeeplyEqual(source, nextSource);
        if (sourceChanged) {
          sourceState.entries.set(sourceIdentity.threadKey, nextSource);
          sourceState.displayOrder = reconcileWorkbenchThreadDisplayOrder(this.naturallyOrderedEntries(sourceState), sourceState.displayOrder);
          try {
            await this.persist(sourceIdentity.projectId, sourceState, [sourceIdentity.threadKey], { layout: true });
          } catch (error) {
            sourceState.entries.set(sourceIdentity.threadKey, priorSource);
            sourceState.displayOrder = priorDisplayOrder;
            throw error;
          }
        }
        this.updatePinnedLayoutEntries(sourceIdentity.projectId, this.naturallyOrderedEntries(sourceState));
        this.updatePinnedLayoutEntries(targetIdentity.projectId, this.naturallyOrderedEntries(targetState));
        try {
          const result = await this.pinnedLayout.dropThread([...this.pinnedEntries.values()], request);
          if (!result.accepted) {
            if (sourceChanged) {
              sourceState.entries.set(sourceIdentity.threadKey, priorSource);
              sourceState.displayOrder = priorDisplayOrder;
              await this.persist(sourceIdentity.projectId, sourceState, [sourceIdentity.threadKey], { layout: true });
              this.updatePinnedLayoutEntries(sourceIdentity.projectId, this.naturallyOrderedEntries(sourceState));
            }
            return { accepted: false, revision: (await this.pinnedLayout.getSnapshot()).revision };
          }
          if (sourceChanged) this.publish(sourceIdentity.projectId, sourceState, nextSource);
          if (result.snapshot) this.publishPinnedLayout(result.snapshot);
          return { accepted: true, revision: result.snapshot?.revision ?? (await this.pinnedLayout.getSnapshot()).revision };
        } catch (error) {
          if (sourceChanged) {
            sourceState.entries.set(sourceIdentity.threadKey, priorSource);
            sourceState.displayOrder = priorDisplayOrder;
            try {
              await this.persist(sourceIdentity.projectId, sourceState, [sourceIdentity.threadKey], { layout: true });
              this.updatePinnedLayoutEntries(sourceIdentity.projectId, this.naturallyOrderedEntries(sourceState));
            } catch {
              throw new Error(`Pinned folder drop failed and source priority rollback could not be persisted: ${sanitizeError(error)}`);
            }
          }
          throw error;
        }
      },
    ));
  }

  private async mutateHomeDisplayOrder(
    connectionId: string,
    request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/home-display-order/move" }>,
  ) {
    const observation = this.connectionProjects.get(connectionId);
    const currentSnapshot = await this.homeDisplayOrder.getSnapshot();
    if (observation?.scope !== "global" || observation.version < 5) {
      return { accepted: false, revision: currentSnapshot.revision };
    }

    const sourceIdentity = parseProjectQualifiedThreadDisplayKey(request.sourceKey);
    if (!sourceIdentity) return { accepted: false, revision: currentSnapshot.revision };
    const sourceState = await this.getProject(sourceIdentity.projectId);
    const destinationIdentity = request.destinationFolderKey
      ? parseProjectQualifiedThreadDisplayKey(request.destinationFolderKey)
      : null;
    if (request.destinationFolderKey && !destinationIdentity) return { accepted: false, revision: currentSnapshot.revision };
    if (destinationIdentity && destinationIdentity.projectId !== sourceIdentity.projectId) {
      return { accepted: false, revision: currentSnapshot.revision };
    }
    const beforeIdentity = request.beforeKey ? parseProjectQualifiedThreadDisplayKey(request.beforeKey) : null;
    if (request.beforeKey && !beforeIdentity) return { accepted: false, revision: currentSnapshot.revision };

    return await this.enqueue("home-display-order", async () => await this.enqueue(
      `${sourceIdentity.projectId}:display-order`,
      async () => {
        const queuedSnapshot = await this.homeDisplayOrder.getSnapshot();
        const sourceFolderId = sourceIdentity.threadKey.startsWith("folder:") ? sourceIdentity.threadKey.slice("folder:".length) : null;
        const sourceFolder = sourceFolderId
          ? sourceState.displayOrder.folders?.find((folder) => folder.folderId === sourceFolderId) ?? null
          : null;
        const sourceEntry = sourceFolder ? null : sourceState.entries.get(sourceIdentity.threadKey) ?? null;
        if ((sourceFolder && sourceFolder.section !== request.section) || (!sourceFolder && !sourceEntry)) {
          return { accepted: false, revision: queuedSnapshot.revision };
        }
        const nextSource = sourceEntry ? setEntryDisplaySection(sourceEntry, request.section) : null;
        if (sourceEntry && !nextSource) return { accepted: false, revision: queuedSnapshot.revision };

        const destinationFolderId = destinationIdentity?.threadKey.startsWith("folder:")
          ? destinationIdentity.threadKey.slice("folder:".length)
          : null;
        const destinationFolder = destinationFolderId
          ? sourceState.displayOrder.folders?.find((folder) => folder.folderId === destinationFolderId) ?? null
          : null;
        if (
          (request.destinationFolderKey && !destinationFolder)
          || (destinationFolder && destinationFolder.section !== request.section)
          || (sourceFolder && destinationFolder)
          || (destinationFolder && beforeIdentity && beforeIdentity.projectId !== sourceIdentity.projectId)
        ) return { accepted: false, revision: queuedSnapshot.revision };

        const priorSource = sourceEntry;
        const sourceChanged = Boolean(sourceEntry && nextSource && !areDeeplyEqual(sourceEntry, nextSource));
        if (sourceEntry && nextSource && sourceChanged) {
          sourceState.entries.set(sourceIdentity.threadKey, nextSource);
        }
        const sourceKeys = sourceFolder
          ? sourceFolder.threadKeys.map((threadKey) => getProjectQualifiedThreadDisplayKey(sourceIdentity.projectId, ThreadDisplayKeySchema.parse(threadKey)))
          : [request.sourceKey];
        const entries = this.homeLayoutEntries();
        let homeBeforeKey = request.beforeKey;
        if (destinationFolder && !homeBeforeKey) {
          const orderedKeys = resolveWorkbenchHomeThreadSectionKeys(entries, queuedSnapshot.displayOrder, request.section);
          const destinationKeys = new Set(destinationFolder.threadKeys.map((threadKey) => (
            getProjectQualifiedThreadDisplayKey(sourceIdentity.projectId, ThreadDisplayKeySchema.parse(threadKey))
          )));
          const lastDestinationIndex = orderedKeys.reduce(
            (lastIndex, key, index) => destinationKeys.has(key) ? index : lastIndex,
            -1,
          );
          homeBeforeKey = orderedKeys.slice(lastDestinationIndex + 1).find((key) => !sourceKeys.includes(key)) ?? null;
        }

        const currentFolder = sourceEntry
          ? findWorkbenchThreadFolder(sourceState.displayOrder, sourceIdentity.threadKey)
          : null;
        const beforeLocalKey = beforeIdentity?.projectId === sourceIdentity.projectId
          ? beforeIdentity.threadKey
          : null;
        const withinSameFolder = Boolean(
          sourceEntry
          && currentFolder
          && destinationFolder
          && currentFolder.folderId === destinationFolder.folderId,
        );
        let nextProjectDisplayOrder = sourceChanged
          ? reconcileWorkbenchThreadDisplayOrder(this.naturallyOrderedEntries(sourceState), sourceState.displayOrder)
          : sourceState.displayOrder;
        if (sourceEntry && destinationFolder) {
          if (beforeLocalKey && !destinationFolder.threadKeys.includes(beforeLocalKey)) {
            if (priorSource) sourceState.entries.set(sourceIdentity.threadKey, priorSource);
            return { accepted: false, revision: queuedSnapshot.revision };
          }
          nextProjectDisplayOrder = moveWorkbenchThreadDisplayItem(
            this.naturallyOrderedEntries(sourceState),
            nextProjectDisplayOrder,
            request.section,
            sourceIdentity.threadKey,
            destinationFolder.folderId,
            beforeLocalKey,
          ) ?? sourceState.displayOrder;
        } else if (sourceEntry && currentFolder) {
          nextProjectDisplayOrder = reconcileWorkbenchThreadDisplayOrder(
            this.naturallyOrderedEntries(sourceState),
            removeWorkbenchThreadFromProjectFolder(sourceState.displayOrder, sourceIdentity.threadKey),
          );
        }

        const priorProjectDisplayOrder = sourceState.displayOrder;
        const projectChanged = sourceChanged || !areDeeplyEqual(nextProjectDisplayOrder, priorProjectDisplayOrder);
        if (projectChanged) {
          sourceState.displayOrder = nextProjectDisplayOrder;
          try {
            await this.persist(sourceIdentity.projectId, sourceState, sourceChanged ? [sourceIdentity.threadKey] : [], { layout: true });
          } catch (error) {
            if (priorSource) sourceState.entries.set(sourceIdentity.threadKey, priorSource);
            sourceState.displayOrder = priorProjectDisplayOrder;
            throw error;
          }
        }

        if (withinSameFolder) {
          if (projectChanged) this.publish(sourceIdentity.projectId, sourceState);
          return { accepted: true, revision: sourceState.revision };
        }

        try {
          const result = await this.homeDisplayOrder.move(
            entries,
            request.section,
            sourceKeys,
            homeBeforeKey,
          );
          if (!result.accepted) {
            if (projectChanged) {
              if (priorSource) sourceState.entries.set(sourceIdentity.threadKey, priorSource);
              sourceState.displayOrder = priorProjectDisplayOrder;
              await this.persist(sourceIdentity.projectId, sourceState, sourceChanged ? [sourceIdentity.threadKey] : [], { layout: true });
            }
            return { accepted: false, revision: queuedSnapshot.revision };
          }
          if (projectChanged) this.publish(sourceIdentity.projectId, sourceState, sourceChanged && nextSource ? nextSource : undefined);
          if (result.snapshot) this.publishHomeDisplayOrder(result.snapshot);
          return {
            accepted: true,
            revision: result.snapshot?.revision ?? queuedSnapshot.revision,
          };
        } catch (error) {
          if (projectChanged) {
            if (priorSource) sourceState.entries.set(sourceIdentity.threadKey, priorSource);
            sourceState.displayOrder = priorProjectDisplayOrder;
            try {
              await this.persist(sourceIdentity.projectId, sourceState, sourceChanged ? [sourceIdentity.threadKey] : [], { layout: true });
            } catch {
              throw new Error(`Home thread move failed and project folder rollback could not be persisted: ${sanitizeError(error)}`);
            }
          }
          throw error;
        }
      },
    ));
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
    const next = previous.catch(() => undefined).then(() => {
      this.assertActive();
      return operation();
    });
    this.operationQueues.set(key, next);
    return next.finally(() => { if (this.operationQueues.get(key) === next) this.operationQueues.delete(key); });
  }

  private async upsertDraft(projectId: ProjectId, draft: WorkbenchThreadDraft, folderId?: string) {
    const state = await this.getProject(projectId);
    return await this.enqueue(folderId ? `${projectId}:display-order` : `${projectId}:draft:${draft.draftId}`, async () => {
      const current = state.drafts.get(draft.draftId);
      if (current && current.clientUpdatedAt > draft.clientUpdatedAt) return { accepted: true, revision: state.revision };
      const targetFolder = folderId ? state.displayOrder.folders?.find((folder) => folder.folderId === folderId) : null;
      if (folderId && (!targetFolder || targetFolder.section === "settled")) return { accepted: false, revision: state.revision };
      const timestamp = this.now();
      const accepted = WorkbenchThreadDraftSchema.parse({ ...draft, createdAt: current?.createdAt ?? timestamp, projectId, updatedAt: timestamp });
      state.drafts.set(accepted.draftId, accepted);
      state.newThreadProfile = this.profileFromDraft(accepted);
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
      await this.persist(projectId, state, [entryKey(entry)], { profile: true, layout: Boolean(targetFolder) });
      this.publish(projectId, state, entry);
      return { accepted: true, revision: state.revision };
    });
  }

  private async moveDraft(sourceProjectId: ProjectId, destinationProjectId: ProjectId, draftId: DraftId) {
    const [sourceState, destinationState] = await Promise.all([
      this.getProject(sourceProjectId),
      this.getProject(destinationProjectId),
    ]);
    return await this.enqueue(`draft:${draftId}`, async () => {
      const sourceDraft = sourceState.drafts.get(draftId);
      const sourceEntry = sourceState.entries.get(`draft:${draftId}`);
      if (!sourceDraft || sourceEntry?.entryKind !== "draft") {
        return { accepted: false, revision: destinationState.revision };
      }
      if (destinationState.drafts.has(draftId) || destinationState.entries.has(`draft:${draftId}`)) {
        return { accepted: false, revision: destinationState.revision };
      }

      const sourceDisplayOrder = sourceState.displayOrder;
      const destinationDisplayOrder = destinationState.displayOrder;
      const movedDraft = WorkbenchThreadDraftSchema.parse({ ...sourceDraft, projectId: destinationProjectId });
      const movedEntry = this.draftEntry(movedDraft, sourceEntry.metadata);
      destinationState.drafts.set(draftId, movedDraft);
      destinationState.entries.set(`draft:${draftId}`, movedEntry);

      try {
        await this.persist(destinationProjectId, destinationState, [getThreadDisplayDraftKey(draftId)]);
      } catch (error) {
        destinationState.drafts.delete(draftId);
        destinationState.entries.delete(`draft:${draftId}`);
        destinationState.displayOrder = destinationDisplayOrder;
        throw error;
      }

      sourceState.drafts.delete(draftId);
      sourceState.entries.delete(`draft:${draftId}`);
      try {
        await this.persist(sourceProjectId, sourceState, [getThreadDisplayDraftKey(draftId)]);
      } catch (error) {
        sourceState.drafts.set(draftId, sourceDraft);
        sourceState.entries.set(`draft:${draftId}`, sourceEntry);
        sourceState.displayOrder = sourceDisplayOrder;
        destinationState.drafts.delete(draftId);
        destinationState.entries.delete(`draft:${draftId}`);
        destinationState.displayOrder = destinationDisplayOrder;
        const rollback = await Promise.allSettled([
          this.persist(sourceProjectId, sourceState, [getThreadDisplayDraftKey(draftId)], { layout: true }),
          this.persist(destinationProjectId, destinationState, [getThreadDisplayDraftKey(draftId)], { layout: true }),
        ]);
        if (rollback.some(({ status }) => status === "rejected")) {
          throw new Error(`Draft move failed and rollback could not be persisted: ${sanitizeError(error)}`);
        }
        throw error;
      }

      if (sourceEntry.metadata.pinned) {
        const pinnedLayoutUpdate = await this.pinnedLayout.remove(sourceProjectId, getThreadDisplayDraftKey(draftId));
        if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
      }
      const homeDisplayOrderUpdate = await this.homeDisplayOrder.replace(
        sourceProjectId,
        getThreadDisplayDraftKey(draftId),
        getThreadDisplayDraftKey(draftId),
        destinationProjectId,
      );
      if (homeDisplayOrderUpdate) this.publishHomeDisplayOrder(homeDisplayOrderUpdate);
      this.publish(sourceProjectId, sourceState);
      this.publish(destinationProjectId, destinationState, movedEntry);
      return { accepted: true, revision: destinationState.revision };
    });
  }

  private async deleteDraft(projectId: ProjectId, draftId: DraftId, clientUpdatedAt: number) {
    const state = await this.getProject(projectId);
    await this.enqueue(`${projectId}:draft:${draftId}`, async () => {
      const current = state.drafts.get(draftId);
      if (current && current.clientUpdatedAt > clientUpdatedAt) return;
      const deletedEntry = state.entries.get(`draft:${draftId}`);
      state.drafts.delete(draftId); state.entries.delete(`draft:${draftId}`);
      if (deletedEntry && getThreadSidebarGroup(deletedEntry) === "pinned") {
        const pinnedLayoutUpdate = await this.pinnedLayout.remove(projectId, getThreadDisplayDraftKey(draftId));
        if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
      }
      const homeDisplayOrderUpdate = await this.homeDisplayOrder.remove(projectId, getThreadDisplayDraftKey(draftId));
      if (homeDisplayOrderUpdate) this.publishHomeDisplayOrder(homeDisplayOrderUpdate);
      await this.persist(projectId, state, [getThreadDisplayDraftKey(draftId)]); this.publish(projectId, state);
    });
    return { accepted: true, revision: state.revision };
  }

  private async mutatePriority(
    request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/priority/set" }>,
  ) {
    const state = await this.getProject(request.projectId);
    return await this.enqueue(`${request.projectId}:thread:${request.sourceKey}`, async () => {
      const beforePublication = new Map(state.entries);
      const entry = state.entries.get(request.sourceKey);
      if (!entry) return { accepted: false, revision: state.revision };
      const next = setEntryPriority(entry, request.priority);
      if (!next) return { accepted: false, revision: state.revision };
      if (areDeeplyEqual(entry, next)) return { accepted: true, revision: state.revision };
      state.entries.set(request.sourceKey, next);
      state.displayOrder = reconcileWorkbenchThreadDisplayOrder(this.naturallyOrderedEntries(state), state.displayOrder);
      if (getThreadSidebarGroup(entry) === "pinned" && getThreadSidebarGroup(next) !== "pinned") {
        const pinnedLayoutUpdate = await this.pinnedLayout.remove(request.projectId, request.sourceKey);
        if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
      }
      await this.persist(request.projectId, state, [request.sourceKey], { layout: true });
      this.publish(request.projectId, state, next, beforePublication);
      return { accepted: true, revision: state.revision };
    });
  }

  private async mutateDependentSnooze(
    request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/snooze/until" }>,
  ) {
    if (sameThreadTarget(request.projectId, request.identity, request.target.projectId, request.target.identity)) {
      const state = await this.getProject(request.projectId);
      return { accepted: false, revision: state.revision };
    }
    const [sourceState, targetState] = await Promise.all([
      this.getProject(request.projectId),
      this.getProject(request.target.projectId),
    ]);
    const sourceKey = `${request.identity.harness}:${request.identity.threadId}`;
    const targetKey = `${request.target.identity.harness}:${request.target.identity.threadId}`;
    return await this.enqueue(`${request.projectId}:thread:${sourceKey}`, async () => {
      const source = sourceState.entries.get(sourceKey);
      const target = targetState.entries.get(targetKey);
      if (
        !source
        || source.entryKind !== "thread"
        || source.metadata.archived
        || source.lifecycle.settled
        || !target
        || target.entryKind !== "thread"
        || target.metadata.archived
      ) return { accepted: false, revision: sourceState.revision };
      const snoozedUntil: WorkbenchThreadSnoozeTarget = request.target;
      const ready = this.isDependentSnoozeTargetReady(request.target.projectId, targetKey);
      const next = parseWorkbenchThreadStateEntry({
        ...source,
        metadata: { ...source.metadata, snoozed: !ready },
        snoozedUntil: ready ? null : snoozedUntil,
      });
      if (next.entryKind !== "thread") return { accepted: false, revision: sourceState.revision };
      if (areDeeplyEqual(source, next)) return { accepted: true, revision: sourceState.revision };
      sourceState.entries.set(sourceKey, next);
      sourceState.displayOrder = reconcileWorkbenchThreadDisplayOrder(this.naturallyOrderedEntries(sourceState), sourceState.displayOrder);
      await this.persist(request.projectId, sourceState, [sourceKey], { layout: true });
      this.publish(request.projectId, sourceState, next);
      return { accepted: true, revision: sourceState.revision };
    });
  }

  private isDependentSnoozeTargetReady(projectId: ProjectId, targetKey: string) {
    const state = this.projects.get(projectId);
    const target = state?.entries.get(targetKey);
    return Boolean(
      state?.freshness === "fresh"
      && target?.entryKind === "thread"
      && target.lifecycle.kind === "completed"
      && !(target.gitArc?.claimedPaths.length),
    );
  }

  private async reevaluateDependentSnoozes(projectId: ProjectId, targetKey: string) {
    if (!this.isDependentSnoozeTargetReady(projectId, targetKey)) return;
    const [harness, ...threadIdParts] = targetKey.split(":");
    const threadId = threadIdParts.join(":");
    if (!WorkbenchHarnessSchema.safeParse(harness).success || !threadId) return;
    const candidates = [...this.projects.entries()].flatMap(([sourceProjectId, state]) => (
      [...state.entries.entries()].flatMap(([sourceKey, entry]) => (
        entry.entryKind === "thread"
        && entry.snoozedUntil
        && sameThreadTarget(
          entry.snoozedUntil.projectId,
          entry.snoozedUntil.identity,
          projectId,
          { harness: harness as WorkbenchHarnessId, threadId },
        )
          ? [{ sourceKey, sourceProjectId, state }]
          : []
      ))
    ));
    await Promise.all(candidates.map(async ({ sourceKey, sourceProjectId, state }) => await this.enqueue(
      `${sourceProjectId}:thread:${sourceKey}`,
      async () => {
        const current = state.entries.get(sourceKey);
        if (
          current?.entryKind !== "thread"
          || !current.snoozedUntil
          || !sameThreadTarget(
            current.snoozedUntil.projectId,
            current.snoozedUntil.identity,
            projectId,
            { harness: harness as WorkbenchHarnessId, threadId },
          )
          || !this.isDependentSnoozeTargetReady(projectId, targetKey)
        ) return;
        const next = parseWorkbenchThreadStateEntry({
          ...current,
          metadata: { ...current.metadata, snoozed: false },
          snoozedUntil: null,
        });
        if (next.entryKind !== "thread") return;
        state.entries.set(sourceKey, next);
        state.displayOrder = reconcileWorkbenchThreadDisplayOrder(this.naturallyOrderedEntries(state), state.displayOrder);
        await this.persist(sourceProjectId, state, [sourceKey], { layout: true });
        this.publish(sourceProjectId, state, next);
      },
    )));
  }

  private async reevaluateAllDependentSnoozes() {
    const targets = new Map<string, { projectId: ProjectId; targetKey: string }>();
    for (const state of this.projects.values()) {
      for (const entry of state.entries.values()) {
        if (entry.entryKind !== "thread" || !entry.snoozedUntil) continue;
        const target = entry.snoozedUntil;
        const targetKey = `${target.identity.harness}:${target.identity.threadId}`;
        targets.set(`${target.projectId}\0${targetKey}`, { projectId: target.projectId, targetKey });
      }
    }
    await Promise.all([...targets.values()].map(({ projectId, targetKey }) => (
      this.reevaluateDependentSnoozes(projectId, targetKey)
    )));
  }

  private async mutateDraft(request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/draft/pin/set" | "workbench/thread-state/draft/snooze/set" }>) {
    const state = await this.getProject(request.projectId);
    return await this.enqueue(`${request.projectId}:draft:${request.draftId}`, async () => {
      const key = getThreadDisplayDraftKey(request.draftId);
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
      if (getThreadSidebarGroup(entry) === "pinned" && getThreadSidebarGroup(next) !== "pinned") {
        const pinnedLayoutUpdate = await this.pinnedLayout.remove(request.projectId, key);
        if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
      }
      await this.persist(request.projectId, state, [key]);
      this.publish(request.projectId, state, next);
      return { accepted: true, revision: state.revision };
    });
  }

  private async mutateDisplayOrder(request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/display-order/folder/create" | "workbench/thread-state/display-order/folder/drop" | "workbench/thread-state/display-order/folder/title/set" | "workbench/thread-state/display-order/move" }>) {
    const state = await this.getProject(request.projectId);
    return await this.enqueue(`${request.projectId}:display-order`, async () => {
      const beforePublication = new Map(state.entries);
      if (request.method === "workbench/thread-state/display-order/folder/drop") {
        return await this.mutateProjectFolderDrop(state, request);
      }
      if (request.method === "workbench/thread-state/display-order/move") {
        return await this.mutateProjectDisplayMove(state, request);
      }
      const entries = this.naturallyOrderedEntries(state);
      const next = request.method === "workbench/thread-state/display-order/folder/create"
        ? createWorkbenchThreadFolder(entries, state.displayOrder, request.folderId, request.sourceKey, request.title)
        : renameWorkbenchThreadFolder(entries, state.displayOrder, request.folderId, request.title);
      if (!next) return { accepted: false, revision: state.revision };
      if (areDeeplyEqual(next, state.displayOrder)) return { accepted: true, revision: state.revision };
      state.displayOrder = next;
      await this.persist(request.projectId, state, [], { layout: true });
      this.publish(request.projectId, state, undefined, beforePublication);
      return { accepted: true, revision: state.revision };
    });
  }

  private async mutateProjectDisplayMove(
    state: ProjectState,
    request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/display-order/move" }>,
  ) {
    const beforePublication = new Map(state.entries);
    const source = state.entries.get(request.sourceKey);
    const nextSource = source ? setEntryDisplaySection(source, request.section) : null;
    if (source && !nextSource) return { accepted: false, revision: state.revision };
    const priorDisplayOrder = state.displayOrder;
    const sourceChanged = Boolean(source && nextSource && !areDeeplyEqual(source, nextSource));
    if (source && nextSource && sourceChanged) state.entries.set(request.sourceKey, nextSource);
    const nextDisplayOrder = moveWorkbenchThreadDisplayItem(
      this.naturallyOrderedEntries(state),
      sourceChanged
        ? reconcileWorkbenchThreadDisplayOrder(this.naturallyOrderedEntries(state), priorDisplayOrder)
        : priorDisplayOrder,
      request.section,
      request.sourceKey,
      request.destinationFolderId,
      request.beforeKey,
    );
    if (!nextDisplayOrder) {
      if (source) state.entries.set(request.sourceKey, source);
      return { accepted: false, revision: state.revision };
    }
    const displayOrderChanged = !areDeeplyEqual(nextDisplayOrder, priorDisplayOrder);
    if (!sourceChanged && !displayOrderChanged) return { accepted: true, revision: state.revision };
    state.displayOrder = nextDisplayOrder;
    try {
      await this.persist(request.projectId, state, sourceChanged ? [request.sourceKey] : [], { layout: true });
    } catch (error) {
      if (source) state.entries.set(request.sourceKey, source);
      state.displayOrder = priorDisplayOrder;
      throw error;
    }
    if (source && nextSource && getThreadSidebarGroup(source) === "pinned" && getThreadSidebarGroup(nextSource) !== "pinned") {
      const pinnedLayoutUpdate = await this.pinnedLayout.remove(request.projectId, entryKey(source));
      if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
    }
    this.publish(request.projectId, state, sourceChanged && nextSource ? nextSource : undefined, beforePublication);
    return { accepted: true, revision: state.revision };
  }

  private async mutateProjectFolderDrop(
    state: ProjectState,
    request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/display-order/folder/drop" }>,
  ) {
    const beforePublication = new Map(state.entries);
    if (request.sourceKey === request.targetKey) return { accepted: false, revision: state.revision };
    const source = state.entries.get(request.sourceKey);
    const target = state.entries.get(request.targetKey);
    if (!source || !target || target.entryKind !== "thread" || getWorkbenchThreadDisplaySection(target) !== request.section) {
      return { accepted: false, revision: state.revision };
    }
    const nextSource = setEntryDisplaySection(source, request.section);
    if (!nextSource) return { accepted: false, revision: state.revision };
    const priorDisplayOrder = state.displayOrder;
    state.entries.set(request.sourceKey, nextSource);
    const entries = this.naturallyOrderedEntries(state);
    let nextDisplayOrder: WorkbenchThreadDisplayOrder | null = null;
    if (request.destinationFolderId) {
      const folder = findWorkbenchThreadFolder(state.displayOrder, request.targetKey);
      if (!folder || folder.folderId !== request.destinationFolderId || folder.section !== request.section) {
        state.entries.set(request.sourceKey, source);
        return { accepted: false, revision: state.revision };
      }
      nextDisplayOrder = moveWorkbenchThreadDisplayItem(
        entries,
        state.displayOrder,
        request.section,
        request.sourceKey,
        folder.folderId,
        folder.threadKeys[0] ?? null,
      );
    } else if (request.folderId) {
      nextDisplayOrder = createWorkbenchThreadFolder(entries, state.displayOrder, request.folderId, request.targetKey, "New folder");
      if (nextDisplayOrder) {
        nextDisplayOrder = moveWorkbenchThreadDisplayItem(
          entries,
          nextDisplayOrder,
          request.section,
          request.sourceKey,
          request.folderId,
          request.targetKey,
        );
      }
    }
    if (!nextDisplayOrder) {
      state.entries.set(request.sourceKey, source);
      return { accepted: false, revision: state.revision };
    }
    state.displayOrder = nextDisplayOrder;
    try {
      await this.persist(request.projectId, state, areDeeplyEqual(source, nextSource) ? [] : [request.sourceKey], { layout: true });
    } catch (error) {
      state.entries.set(request.sourceKey, source);
      state.displayOrder = priorDisplayOrder;
      throw error;
    }
    if (getThreadSidebarGroup(source) === "pinned" && getThreadSidebarGroup(nextSource) !== "pinned") {
      const pinnedLayoutUpdate = await this.pinnedLayout.remove(request.projectId, entryKey(source));
      if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
    }
    this.publish(request.projectId, state, nextSource, beforePublication);
    return { accepted: true, revision: state.revision };
  }

  private async mutateThread(request: Exclude<WorkbenchThreadStateRequest, { method: "workbench/thread-state/observe" | "workbench/thread-state/release" | "workbench/thread-state/open" | "workbench/thread-state/global/open" | "workbench/thread-state/global/close" | "workbench/thread-state/close" | "workbench/thread-state/refresh" | "workbench/thread-state/pin/open" | "workbench/thread-state/draft/upsert" | "workbench/thread-state/draft/move" | "workbench/thread-state/draft/delete" | "workbench/thread-state/draft/pin/set" | "workbench/thread-state/draft/snooze/set" | "workbench/thread-state/priority/set" | "workbench/thread-state/snooze/until" | "workbench/thread-state/display-order/folder/create" | "workbench/thread-state/display-order/folder/drop" | "workbench/thread-state/display-order/folder/title/set" | "workbench/thread-state/display-order/move" | "workbench/thread-state/home-display-order/move" | "workbench/thread-state/pinned-display-order/folder/create" | "workbench/thread-state/pinned-display-order/folder/drop" | "workbench/thread-state/pinned-display-order/folder/title/set" | "workbench/thread-state/pinned-display-order/move" }>) {
    const state = await this.getProject(request.projectId);
    const key = getThreadDisplayThreadKey(request.identity.harness, request.identity.threadId);
    const candidate = state.entries.get(key);
    const snoozingQuestionnaire = request.method === "workbench/thread-state/questionnaire/snooze";
    const snoozeQuestionnaire = snoozingQuestionnaire && candidate?.entryKind === "thread"
      && !candidate.metadata.archived && candidate.lifecycle.kind !== "working"
      && candidate.pendingQuestionnaire?.requestKey === request.requestKey
      ? candidate.pendingQuestionnaire : null;
    if (snoozingQuestionnaire && !snoozeQuestionnaire) return { accepted: false, revision: state.revision };
    const completionQuestionnaire = request.method === "workbench/thread-state/status/set"
      && request.status === "completed" && candidate
      && isWorkbenchSidebarThreadCompletionAvailable(candidate)
      && candidate.entryKind === "thread" && candidate.lifecycle.kind === "needsAttention"
      ? candidate.pendingQuestionnaire ?? null
      : null;
    // Provider I/O must not hold the mutation queue: its interruption notification
    // uses that same queue. Revalidate the captured question after the await.
    const interruptedQuestionnaire = snoozeQuestionnaire ?? completionQuestionnaire;
    if (interruptedQuestionnaire) {
      this.assertActive();
      if (!this.options.interruptQuestionnaire) throw new Error("Questionnaire interruption is unavailable.");
      if (!await this.options.interruptQuestionnaire(request.projectId, request.identity.harness, request.identity.threadId, interruptedQuestionnaire)) {
        return { accepted: false, revision: state.revision };
      }
    }
    const mutate = async () => await this.enqueue(`${request.projectId}:thread:${key}`, async () => {
      const beforePublication = new Map(state.entries);
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft") return { accepted: false, revision: state.revision };
      if (interruptedQuestionnaire && (
        entry.entryKind !== "thread" || entry.metadata.archived || entry.lifecycle.kind === "working"
        || entry.pendingQuestionnaire?.requestKey !== interruptedQuestionnaire.requestKey
        || entry.pendingQuestionnaire.itemId !== interruptedQuestionnaire.itemId
        || entry.pendingQuestionnaire.turnId !== interruptedQuestionnaire.turnId
        || (getWorkbenchLifecycleTurnId(entry.lifecycle) !== null
          && getWorkbenchLifecycleTurnId(entry.lifecycle) !== interruptedQuestionnaire.turnId)
      )) return { accepted: false, revision: state.revision };
      if (request.method === "workbench/thread-state/status/set" && (
        entry.entryKind !== "thread"
        || entry.metadata.archived
        || (isWorkbenchThreadStatusProviderOwned(entry.lifecycle)
          && !(request.status === "completed" && completionQuestionnaire))
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
        && await this.options.hasLiveGitArcClaims(request.projectId, entry.identity.harness, entry.identity.threadId)
      ) {
        return { accepted: false, revision: state.revision };
      }
      let next = entry;
      if (snoozeQuestionnaire && entry.entryKind === "thread") {
        next = {
          ...entry,
          lifecycle: snoozeQuestionnaire.turnId
            ? { kind: "needsAttention", reason: "pendingInput", requestKey: snoozeQuestionnaire.requestKey, turnId: snoozeQuestionnaire.turnId, settled: false }
            : { kind: "needsAttention", reason: "noActiveTurn", settled: false },
          metadata: { archived: false, pinned: entry.metadata.pinned, snoozed: true },
          snoozedUntil: null,
        };
      }
      if (request.method === "workbench/thread-state/pin/set") next = entry.entryKind === "subagent"
        ? { ...entry, pinned: request.pinned }
        : entry.metadata.archived
          ? entry
          : { ...entry, metadata: { archived: false as const, pinned: request.pinned, snoozed: entry.metadata.snoozed } };
      if (entry.entryKind === "thread" && !entry.metadata.archived && request.method === "workbench/thread-state/snooze/set" && !(entry.lifecycle.settled && request.snoozed)) next = { ...entry, metadata: { archived: false, pinned: entry.metadata.pinned, snoozed: request.snoozed }, snoozedUntil: null };
      if (request.method === "workbench/thread-state/settle") {
        const lifecycle = reduceWorkbenchThreadLifecycle(entry.lifecycle, { kind: "settle" });
        next = entry.entryKind === "subagent"
          ? { ...entry, lifecycle, pinned: false }
          : { ...entry, lifecycle, metadata: entry.metadata.archived ? entry.metadata : { ...entry.metadata, snoozed: false }, snoozedUntil: null };
      }
      if (request.method === "workbench/thread-state/restore" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped")) next = {
        ...entry, lifecycle: reduceWorkbenchThreadLifecycle(entry.lifecycle, { kind: "restore" }),
        ...(entry.entryKind === "thread" && entry.metadata.archived ? { metadata: { archived: false as const, pinned: false, snoozed: false } } : {}),
      };
      if (entry.entryKind === "thread" && request.method === "workbench/thread-state/status/set" && entry.lifecycle.kind !== request.status) {
        // Questionnaire completion has stopped its owning turn. Do not retain
        // that turn's agent marker and let a late provider event reopen it.
        const lifecycle = reduceWorkbenchThreadLifecycle(
          completionQuestionnaire ? null : entry.lifecycle,
          request.status === "needsAttention"
            ? { kind: "userNeedsAttention" }
            : request.status === "stopped"
              ? { kind: "userStopped" }
              : { kind: "userCompleted" },
        );
        next = { ...entry, lifecycle, metadata: { ...entry.metadata, snoozed: false }, snoozedUntil: null };
      }
      if (entry.entryKind === "thread" && request.method === "workbench/thread-state/archive/set" && (entry.lifecycle.kind === "completed" || entry.lifecycle.kind === "stopped")) next = { ...entry, metadata: request.archived ? { archived: true, pinned: false, snoozed: false } : { archived: false, pinned: false, snoozed: false }, snoozedUntil: null };
      if (request.method === "workbench/thread-state/questionnaire/dismiss") {
        if (entry.pendingQuestionnaire?.requestKey === request.requestKey) {
          next = entry.entryKind === "thread" ? {
            ...entry, pendingQuestionnaire: null,
            lifecycle: reduceWorkbenchThreadLifecycle(null, { kind: "userStopped" }),
            metadata: { ...entry.metadata, snoozed: false }, snoozedUntil: null,
          } : { ...entry, pendingQuestionnaire: null };
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
          questionnaireHistory: mergeQuestionnaireHistoryEntries(
            entry.questionnaireHistory ?? [],
            [request.entry],
          ),
        };
      }
      const parsed = safeParseWorkbenchThreadStateEntry(next);
      if (!parsed.success) return { accepted: false, revision: state.revision };
      if (areDeeplyEqual(entry, parsed.data)) return { accepted: true, revision: state.revision };
      state.entries.set(key, parsed.data);
      if (getThreadSidebarGroup(entry) === "pinned" && getThreadSidebarGroup(parsed.data) !== "pinned") {
        const pinnedLayoutUpdate = await this.pinnedLayout.remove(request.projectId, key);
        if (pinnedLayoutUpdate) this.publishPinnedLayout(pinnedLayoutUpdate);
      }
      await this.persist(request.projectId, state, [key]); this.publish(request.projectId, state, state.entries.get(key), beforePublication);
      return { accepted: true, revision: state.revision };
    });
    const result = request.method === "workbench/thread-state/settle"
      ? await this.options.runGitArcReadTransition(request.projectId, mutate)
      : await mutate();
    await this.reevaluateDependentSnoozes(request.projectId, key);
    return result;
  }

  private changedEntryKeys(previous: ReadonlyMap<string, WorkbenchThreadStateEntry>, state: ProjectState) {
    return [...new Set([...previous.keys(), ...state.entries.keys()])]
      .filter(key => previous.get(key) !== state.entries.get(key));
  }

  private persist(
    projectId: ProjectId,
    state: ProjectState,
    keys: Iterable<string>,
    options: { previousEntries?: ReadonlyMap<string, WorkbenchThreadStateEntry>; layout?: boolean; profile?: boolean } = {},
  ) {
    const beforeDerived = new Map(state.entries);
    const previousEntries = options.previousEntries ?? beforeDerived;
    const previousOrder = state.displayOrder;
    this.synchronizeSettlementTimestamps(state);
    state.displayOrder = reconcileWorkbenchThreadDisplayOrder(this.naturallyOrderedEntries(state), state.displayOrder);
    const selectedKeys = new Set([...keys, ...this.changedEntryKeys(beforeDerived, state)]);
    const installedEntries = new Map(state.entries);
    const installedOrder = state.displayOrder;
    return this.enqueue(`${projectId}:storage:write`, async () => {
      try {
        // Select keys now, read their current facts at execution. A preceding profile
        // commit must not be overwritten by a record captured while it was pending.
        const changes = this.selectedState(projectId, state, selectedKeys, {
          ...options, layout: options.layout || !areDeeplyEqual(previousOrder, installedOrder),
        });
        await this.options.threadStateStore.writeChanges(projectId, changes);
      } catch (error) {
        for (const key of selectedKeys) {
          if (state.entries.get(key) !== installedEntries.get(key)) continue;
          const previous = previousEntries.get(key);
          if (previous) state.entries.set(key, previous);
          else state.entries.delete(key);
        }
        if (state.displayOrder === installedOrder) state.displayOrder = previousOrder;
        throw error;
      }
      this.archives.reschedule();
    });
  }

  private writeSelectedState(
    projectId: ProjectId, state: ProjectState, keys: Iterable<string>,
    options: { layout?: boolean; profile?: boolean } = {},
  ) {
    return this.options.threadStateStore.writeChanges(projectId, this.selectedState(projectId, state, keys, options));
  }

  private selectedState(
    projectId: ProjectId, state: ProjectState, keys: Iterable<string>,
    options: { layout?: boolean; profile?: boolean },
  ): Omit<WorkbenchThreadStateCommit, "projectId"> {
    const records: WorkbenchThreadStateRecord[] = [];
    const drafts: NonNullable<WorkbenchThreadStateCommit["drafts"]>[number][] = [];
    const deletedDraftIds: DraftId[] = [];
    for (const key of new Set(keys)) {
      const entry = state.entries.get(key);
      if (entry && entry.entryKind !== "draft") {
        records.push(entry);
      } else if (entry?.entryKind === "draft") {
        const draft = state.drafts.get(entry.draft.draftId);
        if (!draft) throw new Error("Draft state is missing its owned content.");
        drafts.push({ draft, pinned: entry.metadata.pinned, snoozed: entry.metadata.snoozed });
      } else if (key.startsWith("draft:")) {
        deletedDraftIds.push(DraftIdSchema.parse(key.slice("draft:".length)));
      } else {
        throw new Error("Selected thread state is missing.");
      }
    }
    return {
      ...(records.length ? { records } : {}),
      ...(drafts.length ? { drafts } : {}),
      ...(deletedDraftIds.length ? { deletedDraftIds } : {}),
      ...(options.profile ? { projectProfiles: [{ projectId, profile: state.newThreadProfile }] } : {}),
      ...(options.layout ? { layouts: [{ owner: { kind: "project", projectId }, revision: 0, displayOrder: state.displayOrder }] } : {}),
    };
  }
}

function recordFromStoredMetadata(candidate: StoredThreadMetadata, projectId: ProjectId) {
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
