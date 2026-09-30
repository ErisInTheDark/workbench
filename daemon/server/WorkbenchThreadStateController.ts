/*
 * Exports:
 * - WorkbenchObservedThreadEntry: sidebar input whose optional title is workbench-owned, never provider-supplied.
 * - WorkbenchThreadStateControllerOptions: catalogue, persistence and lifecycle ports.
 * - WorkbenchThreadReconciliationFailure: bounded provider reconciliation failure.
 * - WorkbenchThreadGitArcSnapshot: project Git arc projection.
 * - WorkbenchThreadClaimContext: thread-owned claim context.
 * - WorkbenchObservedLifecycleEvent: identity-owned provider lifecycle input.
 * - default WorkbenchThreadStateController: coordinate admission, provider observation, cross-project operations, publication, and owned project stores.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { WorkbenchComposerProfileSlot, WorkbenchComposerProfileStorePayload, WorkbenchComposerProfileTargetSelection, WorkbenchProjectsPayload, WorkbenchUserInputResponse } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { resolveLinkedProfileSelection } from "workbench-shared/workbench/thread/thread-profile";
import { DraftIdSchema, ProjectIdSchema, type DraftId, type ProjectId, type WorkbenchThreadId, type WorkbenchTurnId } from "workbench-shared/workbench/identity";
import {
  WorkbenchPresentationAttachmentChunkRequestSchema,
  WorkbenchPresentationAttachmentChunkSchema,
  WorkbenchPresentationExportRequestSchema,
  WorkbenchPresentationExportPageSchema,
  WorkbenchPresentationLayoutChunkRequestSchema,
  WorkbenchPresentationLayoutChunkSchema,
  WorkbenchPresentationManifestPageSchema,
  WorkbenchPresentationManifestRequestSchema,
  type WorkbenchPresentationManifestPage,
} from "workbench-shared/workbench/thread/thread-presentation-export";
import { mergeQuestionnaireHistoryEntries } from "workbench-shared/workbench/thread/thread-questionnaire-identity";
import { isWorkbenchApprovalRequest } from "workbench-shared/workbench/thread/thread-user-input-requests";
import { WORKBENCH_THREAD_WORKING_STATUS_MESSAGE } from "workbench-shared/workbench/thread/thread-recovery-message";
import { currentThreadTitleName, recordThreadTitle } from "workbench-shared/workbench/thread/thread-title-history";
import {
  getThreadDisplayDraftKey,
  getThreadDisplayThreadKey,
} from "workbench-shared/workbench/thread/thread-display-layout";
import {
  findWorkbenchThreadFolder,
  getWorkbenchThreadDisplayKey,
  isWorkbenchThreadDisplayOrderEmpty,
  normalizeWorkbenchThreadDisplayOrder,
  reconcileWorkbenchThreadDisplayOrder,
  resolveWorkbenchThreadDisplayOrder,
  sortThreadSidebarEntries,
  type WorkbenchThreadDisplayOrder,
} from "workbench-shared/workbench/thread/thread-display-order";
import {
  areAllUnsnoozedThreadEntriesSettlementReady,
  createWorkbenchProjectThreadSummary,
  WorkbenchComposerProfileSelectionSchema,
  WorkbenchHarnessSchema,
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
  type WorkbenchGitArcLifecycleState,
  type WorkbenchGitArcPlanState,
  type WorkbenchHarnessId,
  type WorkbenchThreadSidebarEntry,
  type WorkbenchThreadSidebarSnapshot,
  type WorkbenchThreadStateRequest,
  type WorkbenchThreadObservationSnapshot,
  type WorkbenchThreadTarget,
} from "workbench-shared/workbench/thread/thread-state";
import WorkbenchHomeThreadDisplayOrderStore from "./WorkbenchHomeThreadDisplayOrderStore";
import WorkbenchPinnedThreadLayoutStore from "./WorkbenchPinnedThreadLayoutStore";
import WorkbenchThreadArchiveController from "./WorkbenchThreadArchiveController";
import WorkbenchProjectThreadState from "./WorkbenchProjectThreadState";
import {
  setWorkbenchThreadEntryPriority,
} from "./WorkbenchThreadDisplayController";
import {
  conformStoredWorkbenchThreadDraft,
  projectWorkbenchThreadDraft,
  workbenchComposerProfileFromDraft,
} from "./WorkbenchThreadDraftStore";
import type { WorkbenchThreadStatePersistence } from "./WorkbenchThreadStateStore";
import {
  conformStoredWorkbenchThreadStateRecord,
  parseWorkbenchThreadStateEntry,
  projectWorkbenchThreadStateEntry,
  safeParseWorkbenchThreadStateEntry,
  type WorkbenchThreadStateEntry,
  type WorkbenchThreadStateRecord,
  type WorkbenchThreadSnoozeTarget,
} from "./workbench-thread-state-record";

// workbenchTitle is recorded only for workbench-owned relationships; provider inputs stay display labels.
export type WorkbenchObservedThreadEntry = WorkbenchThreadSidebarEntry & { workbenchTitle?: string };

interface StoredThreadMetadata { archived: boolean; harness: WorkbenchHarness; lifecycle: WorkbenchThreadLifecycle; mcpGeneration?: string | null; orderAt?: number; pendingQuestionnaire?: WorkbenchDurableQuestionnaire | null; pinned: boolean; questionnaireHistory?: WorkbenchQuestionnaireHistoryEntryState[]; snoozed: boolean; threadId: string; titleFallback?: string }
type StoredThreadDraft = WorkbenchThreadDraft & { pinned?: boolean; snoozed?: boolean };
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
  if (
    providerEntry.entryKind === "thread"
    && providerEntry.lifecycle.kind === "working"
    && record?.entryKind === "thread"
    && record.lifecycle.kind === "needsAttention"
    && record.lifecycle.reason !== "pendingInput"
    && !record.pendingQuestionnaire
  ) {
    return providerEntry.lifecycle;
  }
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

export interface WorkbenchThreadStateControllerOptions {
  resolveProjectId: (projectId: ProjectId) => ProjectId;
  readComposerProfiles?: () => Promise<WorkbenchComposerProfileStorePayload>;
  recordComposerProfileUsage?: (profileId: string, at: number) => Promise<void>;
  recordComposerModelUsage?: (harness: WorkbenchHarnessId, modelId: string, at: number) => Promise<void>;
  getProjectCatalog: () => WorkbenchProjectsPayload;
  hasGitArcBlockingSettlement: (projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId) => Promise<boolean>;
  log?: (message: string) => void;
  publishAgentContext?: (harness: WorkbenchHarnessId, threadId: WorkbenchThreadId, text: string) => Promise<void>;
  now?: () => number;
  pruneExpiredGitState?: (projectId: ProjectId, identities: Array<{ harness: WorkbenchHarnessId; threadId: WorkbenchThreadId }>) => Promise<ReadonlyArray<{ harness: WorkbenchHarnessId; threadId: WorkbenchThreadId }> | void>;
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
  | { kind: "inputResolved"; requestKey: string; answered?: true }
  | { kind: "pendingInput"; questionnaire: WorkbenchDurableQuestionnaire | null; requestKey: string; turnId: WorkbenchTurnId | null };

type ProjectState = WorkbenchProjectThreadState;

function entryKey(entry: WorkbenchThreadStateEntry | WorkbenchThreadSidebarEntry) {
  if (entry.entryKind === "draft") return getThreadDisplayDraftKey(entry.draft.draftId);
  return getThreadDisplayThreadKey(entry.identity.harness, entry.identity.threadId);
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
  private readonly homeDisplayOrder: WorkbenchHomeThreadDisplayOrderStore;
  private readonly now: () => number;
  private readonly options: WorkbenchThreadStateControllerOptions;
  private readonly pinnedLayout: WorkbenchPinnedThreadLayoutStore;
  private readonly projects = new Map<ProjectId, ProjectState>();
  private readonly operationQueues = new Map<string, Promise<unknown>>();
  private readonly persistenceWrites = new Set<Promise<void>>();
  private readonly retiredError = new Error("Thread-state controller is retired.");
  private readonly reconciliationPromises = new Set<Promise<void>>();
  private readonly subscribers = new Set<(projectId: ProjectId, entry: WorkbenchThreadSidebarEntry) => void>();
  private readonly projectSubscribers = new Set<(projectId: ProjectId) => void>();
  private readonly waitingByThreadKey = new Map<string, "subagents" | "other">();

  private inlineAttachment(url: string) {
    const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/iu.exec(url);
    if (!match) return null;
    const bytes = Buffer.from(match[2]!, "base64");
    return {
      bytes,
      mediaType: `image/${match[1]!.toLowerCase() === "jpg" ? "jpeg" : match[1]!.toLowerCase()}` as
        "image/png" | "image/jpeg" | "image/webp" | "image/gif",
      contentHash: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  /** @deprecated Legacy app-presentation import source; remove after verified migration and backup. */
  async exportPresentationManifestPage(value: z.input<typeof WorkbenchPresentationManifestRequestSchema>) {
    const request = WorkbenchPresentationManifestRequestSchema.parse(value);
    const catalog = this.options.getProjectCatalog().data
      .map(project => project.id).sort((left, right) => left.localeCompare(right));
    const projects = await Promise.all(catalog.map(async projectId => ({
      projectId, state: await this.getProject(projectId),
    })));
    const sources: WorkbenchPresentationManifestPage["sources"] = projects.flatMap(({ projectId, state }) => [
      ...[...state.drafts.keys()].sort((left, right) => left.localeCompare(right))
        .map(sourceId => ({ kind: "draft" as const, projectId, sourceId: DraftIdSchema.parse(sourceId) })),
      ...(isWorkbenchThreadDisplayOrderEmpty(state.displayOrder)
        ? [] : [{ kind: "projectLayout" as const, projectId, sourceId: `project:${projectId}` }]),
    ]);
    const [home, pinned] = await Promise.all([
      this.homeDisplayOrder.getSnapshot(), this.pinnedLayout.getSnapshot(),
    ]);
    if (!isWorkbenchThreadDisplayOrderEmpty(home.displayOrder)) {
      sources.push({ kind: "homeLayout", sourceId: "home" });
    }
    if (!isWorkbenchThreadDisplayOrderEmpty(pinned.displayOrder)) {
      sources.push({ kind: "pinnedLayout", sourceId: "pinned" });
    }
    const signature = createHash("sha256").update(sources.map(source =>
      `${source.kind}\0${"projectId" in source ? source.projectId : ""}\0${source.sourceId}`).join("\n")).digest("hex");
    const cursor = request.cursor
      ? z.object({ signature: z.string().length(64), index: z.number().int().nonnegative() }).strict()
        .parse(JSON.parse(request.cursor))
      : { signature, index: 0 };
    if (cursor.signature !== signature) throw new Error("Presentation sources changed during manifest read.");
    const page = sources.slice(cursor.index, cursor.index + request.limit);
    const next = cursor.index + page.length;
    return WorkbenchPresentationManifestPageSchema.parse({
      sources: page,
      nextCursor: next < sources.length ? JSON.stringify({ signature, index: next }) : null,
    });
  }

  /** @deprecated Legacy app-presentation import source; remove after verified migration and backup. */
  async exportPresentationPage(value: z.input<typeof WorkbenchPresentationExportRequestSchema>) {
    const request = WorkbenchPresentationExportRequestSchema.parse(value);
    const state = await this.getProject(request.projectId);
    const cursor = request.cursor
      ? z.object({ revision: z.number().int().nonnegative(), index: z.number().int().nonnegative() }).strict()
        .parse(JSON.parse(request.cursor))
      : { revision: state.revision, index: 0 };
    if (cursor.revision !== state.revision) throw new Error("Draft source changed during export; restart the page read.");
    const selectedDraftIds = request.draftIds ? new Set(request.draftIds) : null;
    const drafts = [...state.drafts.values()]
      .filter(draft => !selectedDraftIds || selectedDraftIds.has(DraftIdSchema.parse(draft.draftId)))
      .sort((left, right) => left.draftId.localeCompare(right.draftId));
    const page = drafts.slice(cursor.index, cursor.index + request.limit).map(draft => {
      const entry = state.entries.get(`draft:${draft.draftId}`);
      return {
        draftId: draft.draftId, prompt: draft.prompt,
        createdAt: draft.createdAt, updatedAt: draft.updatedAt,
        clientUpdatedAt: draft.clientUpdatedAt,
        profileId: draft.profileId, composerSettings: draft.composerSettings,
        pinned: entry?.entryKind === "draft" && entry.metadata.pinned,
        snoozed: entry?.entryKind === "draft" && entry.metadata.snoozed,
        attachments: draft.attachments.map(attachment => {
          const inline = this.inlineAttachment(attachment.url);
          return inline
            ? { kind: "inline" as const, id: attachment.id, mediaType: inline.mediaType,
              byteLength: inline.bytes.length, contentHash: inline.contentHash }
            : { kind: "url" as const, id: attachment.id, url: attachment.url };
        }),
      };
    });
    const next = cursor.index + page.length;
    return WorkbenchPresentationExportPageSchema.parse({
      projectId: request.projectId,
      sourceRevision: state.revision,
      drafts: page,
      nextCursor: next < drafts.length ? JSON.stringify({ revision: state.revision, index: next }) : null,
    });
  }

  /** @deprecated Legacy app-presentation import source; remove after verified migration and backup. */
  async exportPresentationLayoutChunk(value: z.input<typeof WorkbenchPresentationLayoutChunkRequestSchema>) {
    const request = WorkbenchPresentationLayoutChunkRequestSchema.parse(value);
    const source = request.scope === "project"
      ? await this.getProject(request.projectId).then(state => ({
        revision: state.revision,
        content: { displayOrder: state.displayOrder, newThreadProfile: state.newThreadProfile },
      }))
      : request.scope === "home"
        ? await this.homeDisplayOrder.getSnapshot().then(state => ({
          revision: state.revision, content: state.displayOrder,
        }))
        : await this.pinnedLayout.getSnapshot().then(state => ({
          revision: state.revision, content: state.displayOrder,
        }));
    const revision = source.revision;
    if (request.sourceRevision !== null && request.sourceRevision !== revision) {
      throw new Error("Layout source changed during export; restart the chunk read.");
    }
    const bytes = Buffer.from(JSON.stringify(source.content), "utf8");
    if (request.offset > bytes.length) throw new Error("Layout offset exceeds its content.");
    const chunk = bytes.subarray(request.offset, request.offset + 64 * 1024);
    const next = request.offset + chunk.length;
    return WorkbenchPresentationLayoutChunkSchema.parse({
      sourceRevision: revision, bytes: chunk.toString("base64"),
      totalBytes: bytes.length, nextOffset: next < bytes.length ? next : null,
    });
  }

  /** @deprecated Legacy app-presentation import source; remove after verified migration and backup. */
  async readPresentationAttachmentChunk(value: z.input<typeof WorkbenchPresentationAttachmentChunkRequestSchema>) {
    const request = WorkbenchPresentationAttachmentChunkRequestSchema.parse(value);
    const state = await this.getProject(request.projectId);
    const attachment = state.drafts.get(request.draftId)?.attachments.find(item => item.id === request.attachmentId);
    if (!attachment) throw new Error("Draft attachment is no longer available.");
    const inline = this.inlineAttachment(attachment.url);
    if (!inline) throw new Error("Draft attachment is not stored as inline content.");
    if (request.offset > inline.bytes.length) throw new Error("Attachment offset exceeds its content.");
    const bytes = inline.bytes.subarray(request.offset, request.offset + 64 * 1024);
    const nextOffset = request.offset + bytes.length;
    return WorkbenchPresentationAttachmentChunkSchema.parse({
      bytes: bytes.toString("base64"),
      nextOffset: nextOffset < inline.bytes.length ? nextOffset : null,
      byteLength: inline.bytes.length, contentHash: inline.contentHash, mediaType: inline.mediaType,
    });
  }

  constructor(options: WorkbenchThreadStateControllerOptions) {
    const persistence = options.threadStateStore;
    const ownedPersistence: WorkbenchThreadStatePersistence = {
      writeChanges: (projectId, changes) => this.writePersistence(() => persistence.writeChanges(projectId, changes)),
      readNextArchiveEligibility: () => this.readPersistence(() => persistence.readNextArchiveEligibility()),
      readArchiveEligible: before => this.readPersistence(() => persistence.readArchiveEligible(before)),
      readGlobal: id => this.readPersistence(() => persistence.readGlobal(id)),
      readProject: projectId => this.readPersistence(() => persistence.readProject(projectId)),
      readNavigationSummary: projectId => this.readPersistence(() => persistence.readNavigationSummary(projectId)),
      readTitleHistories: projectId => this.readPersistence(() => persistence.readTitleHistories(projectId)),
      writeGlobal: (id, document) => this.writePersistence(() => persistence.writeGlobal(id, document)),
      writeProject: (projectId, document, histories) => this.writePersistence(() => persistence.writeProject(projectId, document, histories)),
    };
    this.options = { ...options, threadStateStore: ownedPersistence };
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

  private async handleRequestOwned(_connectionId: string, input: WorkbenchThreadStateRequest | object) {
    const parsed = WorkbenchThreadStateRequestSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      if (issue) this.options.log?.(`request invalid method=${sanitizeLogValue((input as { method?: unknown }).method)} ${describeInvalidRequest(input, issue)}`);
      return { error: { code: "invalidThreadStateMutation", message: issue?.message ?? "Invalid thread-state request." } };
    }
    const request = this.canonicalRequest(parsed.data);
    switch (request.method) {
      case "workbench/thread-state/title/set":
      case "workbench/thread-state/title/dismiss": {
        const owner = await this.getCanonicalThreadEntry(request.projectId, request.identity.threadId);
        if (!owner || owner.entryKind === "draft" || owner.identity.harness !== request.identity.harness) {
          return { error: { code: "invalidThreadOwner", message: "The title request does not match an admitted thread in this project." } };
        }
        try {
          return { result: request.method === "workbench/thread-state/title/set"
            ? await this.renameThread(request)
            : await this.dismissTitle(request) };
        } catch (error) {
          return { error: { code: "threadTitleMutationFailed", message: sanitizeError(error) } };
        }
      }
      case "workbench/thread-state/priority/set": return { result: await this.mutatePriority(request) };
      case "workbench/thread-state/snooze/until": return { result: await this.mutateDependentSnooze(request) };
      default: return { result: await this.mutateThread(request) };
    }
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

  private acceptedIntentEntry(input: { harness: WorkbenchHarnessId; threadId: WorkbenchThreadId; title: string; turnId: WorkbenchTurnId; pinned?: boolean }): WorkbenchThreadSidebarEntry {
    const activityAt = this.now();
    return {
      activityAt, entryKind: "thread", identity: { harness: input.harness, threadId: input.threadId },
      lifecycle: { agent: { agentStatus: "working", turnId: input.turnId }, kind: "working", reason: "acceptedIntent", settled: false },
      metadata: { archived: false, pinned: input.pinned ?? false, snoozed: false },
      orderAt: activityAt, title: input.title,
    };
  }

  private canonicalProjectId(projectId: ProjectId) {
    return this.options.resolveProjectId(projectId);
  }

  private canonicalRequest(request: WorkbenchThreadStateRequest): WorkbenchThreadStateRequest {
    if ("projectId" in request) request = { ...request, projectId: this.canonicalProjectId(request.projectId) };
    if (request.method === "workbench/thread-state/snooze/until") {
      return { ...request, target: { ...request.target, projectId: this.canonicalProjectId(ProjectIdSchema.parse(request.target.projectId)) } };
    }
    return request;
  }

  async acceptProviderIntent(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId, turnId: WorkbenchTurnId, firstMessagePreview?: string) {
    const providerEntry = this.acceptedIntentEntry({
      harness, threadId, turnId,
      title: resolveWorkbenchThreadTitle({ id: threadId, name: null, preview: firstMessagePreview }),
    });
    return await this.applyLifecycle(projectId, harness, threadId, { kind: "acceptedIntent", turnId }, providerEntry);
  }

  async reportRecoveryFailed(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId) {
    return await this.applyLifecycle(projectId, harness, threadId, { kind: "recoveryFailed" });
  }

  async refresh(projectId: ProjectId) {
    projectId = this.canonicalProjectId(projectId);
    const state = await this.getProject(projectId);
    void this.reconcile(projectId, state);
    return this.snapshot(projectId, state);
  }

  async ensureProviderEntry(projectId: ProjectId, providerEntry: Exclude<WorkbenchObservedThreadEntry, { entryKind: "draft" }>) {
    projectId = this.canonicalProjectId(projectId);
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
    projectId = this.canonicalProjectId(projectId);
    const state = await this.getProject(projectId);
    const entry = state.entries.get(`${harness}:${threadId}`);
    return entry?.entryKind === "draft" ? null : entry?.mcpGeneration ?? null;
  }

  async setMcpGeneration(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId, generation: string) {
    projectId = this.canonicalProjectId(projectId);
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
    return this.readComposerProfile(slot, true);
  }

  readComposerProfileSnapshot(slot: WorkbenchComposerProfileSlot): Promise<WorkbenchComposerProfileTargetSelection | null> {
    return this.readComposerProfile(slot, false);
  }

  private readComposerProfile(slot: WorkbenchComposerProfileSlot, refresh: boolean) {
    slot = { ...slot, projectId: this.canonicalProjectId(slot.projectId) };
    const key = `${slot.projectId}:profiles`;
    const pending = this.operationQueues.get(key);
    return this.enqueue(key, async () => {
      await pending;
      return await this.resolveComposerProfileTarget(await this.getProject(slot.projectId), slot, refresh);
    });
  }

  setComposerProfileTarget(slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection) {
    slot = { ...slot, projectId: this.canonicalProjectId(slot.projectId) };
    const parsed = WorkbenchComposerProfileSelectionSchema.parse(selection);
    return this.enqueue(`${slot.projectId}:profiles`, async () => {
      return await this.persistComposerProfileTarget(await this.getProject(slot.projectId), slot, parsed);
    });
  }

  prepareComposerProfileTarget(slot: WorkbenchComposerProfileSlot) {
    slot = { ...slot, projectId: this.canonicalProjectId(slot.projectId) };
    const key = `${slot.projectId}:profiles`;
    const pending = this.operationQueues.get(key);
    return this.enqueue(key, async () => {
      await pending;
      const state = await this.getProject(slot.projectId);
      const selection = await this.resolveComposerProfileTarget(state, slot, true);
      if (!selection) throw new Error("The thread has no available daemon composer profile.");
      if (!selection.settings.model.trim()) throw new Error("The thread has no available daemon composer model.");
      const entry = slot.kind === "thread" ? state.entries.get(`${slot.harness}:${slot.threadId}`) : null;
      return { selection, subagentName: entry?.entryKind === "subagent" ? entry.name : null };
    });
  }

  withComposerProfileAdmission<Result>(
    slot: Extract<WorkbenchComposerProfileSlot, { kind: "thread" }>,
    admit: (profile: { selection: WorkbenchComposerProfileTargetSelection; subagentName: string | null }) => Promise<{ accepted: boolean; result: Result }>,
    signal: AbortSignal,
    refresh = true,
  ): Promise<{ accepted: boolean; result: Result; profilePersistenceError: string | null }> {
    const key = `${slot.projectId}:profiles`;
    const pending = this.operationQueues.get(key);
    return this.enqueue(key, async () => {
      await pending;
      signal.throwIfAborted();
      const state = await this.getProject(slot.projectId);
      const selection = await this.resolveComposerProfileTarget(state, slot, refresh);
      if (!selection) throw new Error("The thread has no available daemon composer profile.");
      if (!selection.settings.model.trim()) throw new Error("The thread has no available daemon composer model.");
      const entry = state.entries.get(`${slot.harness}:${slot.threadId}`);
      const outcome = await admit({ selection, subagentName: entry?.entryKind === "subagent" ? entry.name : null });
      if (!outcome.accepted) return { ...outcome, profilePersistenceError: null };
      const acceptedAt = this.now();
      // Native acceptance is irreversible. A failed snapshot write must never turn it into an unsent message.
      try {
        const [snapshot, usage] = await Promise.allSettled([
          this.persistComposerProfileTarget(state, slot, selection),
          this.recordAcceptedSelection(selection, acceptedAt),
        ] as const);
        const failures = [
          snapshot.status === "rejected" ? sanitizeError(snapshot.reason)
            : !snapshot.value ? "The accepted turn's composer profile target no longer exists." : null,
          usage.status === "rejected" ? sanitizeError(usage.reason) : null,
        ].filter((message): message is string => message !== null);
        if (failures.length) throw new Error(failures.join(" / "));
        return { ...outcome, profilePersistenceError: null };
      } catch (error) {
        const profilePersistenceError = `Turn accepted, but its profile could not be saved: ${sanitizeError(error)}`;
        this.options.log?.(profilePersistenceError);
        state.error = profilePersistenceError;
        this.publish(slot.projectId, state);
        return { ...outcome, profilePersistenceError };
      }
    });
  }

  private async resolveComposerProfileTarget(state: ProjectState, slot: WorkbenchComposerProfileSlot, refresh = false): Promise<WorkbenchComposerProfileTargetSelection | null> {
    const entry = slot.kind === "thread" ? state.entries.get(`${slot.harness}:${slot.threadId}`) : null;
    const draft = slot.kind === "draft" ? state.drafts.get(slot.draftId) : null;
    if (slot.kind === "thread" && (!entry || entry.entryKind === "draft")) return null;
    if (slot.kind === "draft" && !draft) return null;
    let selection = slot.kind === "new-thread" ? state.newThreadProfile
      : draft ? state.draftStore.profileFromDraft(draft)
        : entry && entry.entryKind !== "draft" ? entry.profile
          : null;
    if (refresh && !selection && slot.kind === "thread" && entry?.entryKind === "thread"
      && state.newThreadProfile?.settings.harness === slot.harness) {
      selection = state.newThreadProfile;
    }
    const link = selection?.kind === "profile" ? { profileId: selection.profileId, settings: selection.settings }
      : refresh && !selection && entry?.entryKind === "subagent" && entry.profileId
        ? { profileId: entry.profileId, settings: null } : null;
    if (refresh && link) {
      if (!this.options.readComposerProfiles) throw new Error("The daemon composer profile catalogue is unavailable.");
      // A deleted definition, or a linked thread definition whose provider drifted, previews the saved Custom snapshot.
      selection = resolveLinkedProfileSelection((await this.options.readComposerProfiles()).profiles, link,
        slot.kind === "thread" ? { harness: slot.harness } : undefined);
    }
    if (!selection || !selection.settings.model.trim()
      && (slot.kind === "thread" || selection.kind !== "custom" || selection.settings.harness !== "opencode")) return null;
    if (slot.kind === "thread" && selection.settings.harness !== slot.harness) {
      throw new Error("The daemon composer profile harness does not match the thread.");
    }
    return WorkbenchComposerProfileSelectionSchema.parse(selection);
  }

  private installComposerProfileTarget(state: ProjectState, slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection) {
    if (slot.kind === "new-thread") {
      state.newThreadProfile = selection;
    } else if (slot.kind === "draft") {
      const draft = state.drafts.get(slot.draftId);
      if (!draft) return false;
      const next = {
        ...draft, composerSettings: selection.settings,
        profileId: selection.kind === "profile" ? selection.profileId : null,
      };
      state.drafts.set(slot.draftId, next);
      const entry = state.entries.get(`draft:${slot.draftId}`);
      state.entries.set(`draft:${slot.draftId}`, state.draftStore.projectEntry(next, entry?.entryKind === "draft" ? entry.metadata : undefined));
      state.newThreadProfile = selection;
    } else {
      const key = `${slot.harness}:${slot.threadId}`;
      const entry = state.entries.get(key);
      if (!entry || entry.entryKind === "draft" || selection.settings.harness !== slot.harness
        || !selection.settings.model.trim()) return false;
      state.entries.set(key, { ...entry, profile: selection });
    }
    return true;
  }

  private persistComposerProfileTarget(state: ProjectState, slot: WorkbenchComposerProfileSlot, selection: WorkbenchComposerProfileTargetSelection) {
    return this.enqueue(`${slot.projectId}:storage:write`, async () => {
      // Stage only profile mutations: other queued writes must never observe an unacknowledged selection.
      const staged = state.stage();
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
    harness: WorkbenchHarness,
    threadId: WorkbenchThreadId,
    event: WorkbenchLifecycleEvent,
    providerEntry?: WorkbenchObservedThreadEntry,
    questionnaireMutation?: QuestionnaireStateMutation,
    profile?: WorkbenchComposerProfileSelectionState | null,
    promotedDraftId?: DraftId,
  ) {
    projectId = this.canonicalProjectId(projectId);
    const state = await this.getProject(projectId);
    const key = `${harness}:${threadId}`;
    const result = await this.enqueue(`${projectId}:thread:${key}`, async () => {
      const beforePublication = new Map(state.entries);
      const wakeReadyBefore = areAllUnsnoozedThreadEntriesSettlementReady(this.naturallyOrderedEntries(state));
      if (!state.entries.has(key) && providerEntry?.entryKind === "thread" && entryKey(providerEntry) === key) {
        const { workbenchTitle, ...sidebarEntry } = providerEntry;
        state.entries.set(key, parseWorkbenchThreadStateEntry({
          ...sidebarEntry, mcpGeneration: null, providerObserved: true,
          titleHistory: recordThreadTitle([], "", workbenchTitle ?? "", this.now()),
        }));
      }
      const existing = state.entries.get(key);
      if (!existing || existing.entryKind === "draft") return null;
      const validatedEvent = event.kind === "inputResolved" && event.answered && (
        existing.entryKind !== "thread"
        || existing.pendingQuestionnaire?.requestKey !== event.requestKey
      ) ? { ...event, answered: undefined } : event;
      const ownedEvent = existing.entryKind === "subagent" && event.kind === "turnCompleted" && event.status === "completed"
        ? { kind: "agentStatus" as const, status: "completed" as const, turnId: event.turnId }
        : validatedEvent;
      const reducedLifecycle = reduceWorkbenchThreadLifecycle(existing.lifecycle, ownedEvent);
      const heldQuestionnaire = this.heldQuestionnaire(existing, questionnaireMutation);
      const retainedQuestionnaire = existing.entryKind === "thread"
        && existing.lifecycle.kind === "needsAttention"
        && existing.lifecycle.reason === "pendingInput"
        && event.kind === "turnCompleted";
      // The lifecycle is the only input the shared recovery gate reads, so a thread that is
      // waiting on a questionnaire must never be left in the state that gate treats as resumable,
      // and a turn boundary must not end the wait.
      const recoverableLifecycle = reducedLifecycle.kind === "needsAttention" && reducedLifecycle.reason === "noActiveTurn";
      const lifecycle = heldQuestionnaire && (retainedQuestionnaire || recoverableLifecycle)
        ? this.waitOnQuestionnaire(existing.lifecycle, heldQuestionnaire)
        : reducedLifecycle;
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
          ...(event.kind === "acceptedIntent" && !existing.profile ? { profile: profile ?? null } : {}),
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
        titleHistory: recordThreadTitle(existing.titleHistory ?? [], currentThreadTitleName(existing.titleHistory ?? []) ?? "", providerEntry?.workbenchTitle ?? "", this.now()),
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
      this.publish(projectId, state, parsedNext);
      if (ownedEvent.kind === "acceptedIntent" || ownedEvent.kind === "userInputDelivered"
        || (ownedEvent.kind === "inputResolved" && ownedEvent.answered)) {
        await this.publishWorkingTransition(existing, parsedNext, ownedEvent.kind === "inputResolved");
      }
      return parsedNext;
    });
    await this.reevaluateDependentSnoozes(projectId, key);
    return result;
  }

  private async publishWorkingTransition(before: WorkbenchThreadStateEntry, after: WorkbenchThreadStateEntry, answered = false) {
    if (before.entryKind !== "thread" || after.entryKind !== "thread" || after.lifecycle.kind !== "working") return;
    const previous = before.lifecycle;
    if (previous.kind !== "completed" && !(previous.kind === "needsAttention"
      && (previous.reason === "agentBlocked" || (answered && previous.reason === "pendingInput")))) return;
    try {
      await this.options.publishAgentContext?.(after.identity.harness, after.identity.threadId, WORKBENCH_THREAD_WORKING_STATUS_MESSAGE);
    } catch {
      this.options.log?.("Working status was saved, but agent context admission failed.");
    }
  }

  private heldQuestionnaire(
    existing: WorkbenchThreadStateEntry,
    mutation: QuestionnaireStateMutation | undefined,
  ): WorkbenchDurableQuestionnaire | null {
    if (existing.entryKind !== "thread") return null;
    const held = mutation?.kind === "set"
      ? mutation.questionnaire
      : mutation?.kind === "clear" && existing.pendingQuestionnaire?.requestKey === mutation.requestKey
        ? null
        : existing.pendingQuestionnaire ?? null;
    return held && !isWorkbenchApprovalRequest(held.request) ? held : null;
  }

  private waitOnQuestionnaire(
    current: WorkbenchThreadLifecycle,
    questionnaire: WorkbenchDurableQuestionnaire,
  ): WorkbenchThreadLifecycle {
    if (current.kind === "needsAttention" && current.reason === "pendingInput"
      && current.requestKey === questionnaire.requestKey) return current;
    const turnId = getWorkbenchLifecycleTurnId(current) ?? questionnaire.turnId;
    return {
      kind: "needsAttention", reason: "pendingInput", requestKey: questionnaire.requestKey, settled: false,
      ...(turnId ? { turnId } : {}),
    };
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

  listPendingQuestionnaires(harness?: WorkbenchHarnessId) {
    return [...this.projects.values()].flatMap(state =>
      [...state.entries.values()].flatMap(entry =>
        entry.entryKind === "thread"
          && (!harness || entry.identity.harness === harness)
          && !entry.metadata.archived
          && entry.pendingQuestionnaire
          ? [{
            harness: entry.identity.harness,
            ...entry.pendingQuestionnaire,
            itemId: entry.pendingQuestionnaire.itemId ?? null,
            threadId: entry.identity.threadId,
            turnId: entry.pendingQuestionnaire.turnId ?? null,
          }]
          : []),
    );
  }

  async getThreadEntry(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId) {
    projectId = this.canonicalProjectId(projectId);
    const state = await this.getProject(projectId);
    return this.naturallyOrderedEntries(state).find(entry => entry.entryKind !== "draft"
      && entry.identity.harness === harness && entry.identity.threadId === threadId) ?? null;
  }

  async getCanonicalThreadEntry(projectId: ProjectId, threadId: WorkbenchThreadId) {
    projectId = this.canonicalProjectId(projectId);
    const state = await this.getProject(projectId);
    return [...state.entries.values()].find(entry => entry.entryKind !== "draft" && entry.identity.threadId === threadId) ?? null;
  }

  async setAgentStatus(projectId: ProjectId, threadId: WorkbenchThreadId, status: "completed" | "blocked") {
    projectId = this.canonicalProjectId(projectId);
    const entry = await this.getCanonicalThreadEntry(projectId, threadId);
    if (!entry || entry.entryKind === "draft") throw new Error("The managed thread has no stored thread state.");
    const next = await this.applyLifecycle(projectId, entry.identity.harness, threadId, { kind: "agentStatus", status });
    if (!next || !("agent" in next.lifecycle) || next.lifecycle.agent?.agentStatus !== status) {
      throw new Error("The thread status was not applied.");
    }
    return next;
  }

  async setPendingQuestionnaire(projectId: ProjectId, threadId: WorkbenchThreadId, questionnaire: WorkbenchDurableQuestionnaire) {
    projectId = this.canonicalProjectId(projectId);
    const entry = await this.getCanonicalThreadEntry(projectId, threadId);
    if (!entry || entry.entryKind === "draft") throw new Error("The questionnaire thread has no stored thread state.");
    const next = await this.applyLifecycle(projectId, entry.identity.harness, threadId,
      { kind: "pendingInput", requestKey: questionnaire.requestKey }, undefined, { kind: "set", questionnaire });
    if (!next) throw new Error("The questionnaire could not be stored.");
    return next;
  }

  async clearPendingQuestionnaire(projectId: ProjectId, threadId: WorkbenchThreadId, requestKey: string, answered?: true) {
    projectId = this.canonicalProjectId(projectId);
    const entry = await this.getCanonicalThreadEntry(projectId, threadId);
    if (!entry || entry.entryKind === "draft") throw new Error("The questionnaire thread has no stored thread state.");
    return this.applyLifecycle(projectId, entry.identity.harness, threadId,
      { kind: "inputResolved", requestKey, ...(answered ? { answered } : {}) }, undefined, { kind: "clear", requestKey });
  }

  async resolvePendingQuestionnaire<TDelivery>(
    input: {
      harness: WorkbenchHarnessId;
      projectId: ProjectId;
      requestKey: string;
      resolvedAt: number;
      response: WorkbenchUserInputResponse;
      threadId: WorkbenchThreadId;
    },
    deliver: (context: {
      lifecycle: WorkbenchThreadLifecycle;
      questionnaire: WorkbenchDurableQuestionnaire;
    }) => Promise<{
      delivery: TDelivery;
      insertAfterItemId: string | null;
      insertAfterItemIndex: number | null;
      turnId: WorkbenchTurnId;
    }>,
  ) {
    input = { ...input, projectId: this.canonicalProjectId(input.projectId) };
    const state = await this.getProject(input.projectId);
    const key = `${input.harness}:${input.threadId}`;
    const candidate = state.entries.get(key);
    const questionnaire = candidate?.entryKind !== "draft" ? candidate?.pendingQuestionnaire : null;
    if (!questionnaire || questionnaire.requestKey !== input.requestKey) return null;
    const matches = (question: WorkbenchDurableQuestionnaire | null | undefined) => (
      question?.requestKey === questionnaire.requestKey && question.itemId === questionnaire.itemId
    );
    const mutationKey = `${input.projectId}:thread:${key}`;
    return await this.enqueue(`${input.projectId}:questionnaire:${key}`, async () => {
      const context = await this.enqueue(mutationKey, async () => {
        const current = state.entries.get(key);
        if (!current || current.entryKind === "draft" || !matches(current.pendingQuestionnaire)
          || current.questionnaireHistory?.some(matches)) return null;
        return { lifecycle: current.lifecycle, questionnaire };
      });
      if (!context) return null;
      // Admission mutates this thread's MCP state. Never hold its mutation queue
      // across delivery, or the global Codex command queue deadlocks behind it.
      const accepted = await deliver(context);
      const historyEntry: WorkbenchQuestionnaireHistoryEntryState = {
        ...questionnaire,
        insertAfterItemId: accepted.insertAfterItemId,
        insertAfterItemIndex: accepted.insertAfterItemIndex,
        resolvedAt: input.resolvedAt,
        response: input.response,
        threadId: input.threadId,
        turnId: accepted.turnId,
      };
      return await this.enqueue(mutationKey, async () => {
        const current = state.entries.get(key);
        if (!current || current.entryKind === "draft") {
          throw new Error("The questionnaire response was delivered but its thread was removed before settlement.");
        }
        const previousEntries = new Map(state.entries);
        const clearsPendingQuestionnaire = matches(current.pendingQuestionnaire);
        const lifecycle = clearsPendingQuestionnaire && areDeeplyEqual(current.lifecycle, context.lifecycle)
          ? reduceWorkbenchThreadLifecycle(
            reduceWorkbenchThreadLifecycle(current.lifecycle, {
              kind: "inputResolved",
              requestKey: questionnaire.requestKey,
            }),
            { kind: "acceptedIntent", turnId: accepted.turnId },
          )
          : current.lifecycle;
        const next = parseWorkbenchThreadStateEntry({
          ...current,
          lifecycle,
          pendingQuestionnaire: clearsPendingQuestionnaire ? null : current.pendingQuestionnaire,
          questionnaireHistory: mergeQuestionnaireHistoryEntries(
            current.questionnaireHistory ?? [],
            [historyEntry],
          ),
        });
        if (next.entryKind === "draft") throw new Error("Questionnaire completion cannot produce a draft entry.");
        state.entries.set(key, next);
        await this.persist(input.projectId, state, [key], { previousEntries });
        this.publish(input.projectId, state, next);
        await this.publishWorkingTransition(current, next, true);
        return { delivery: accepted.delivery, historyEntry };
      });
    });
  }

  async getRevision(projectId: ProjectId) {
    projectId = this.canonicalProjectId(projectId);
    return (await this.getProject(projectId)).revision;
  }

  async observeLifecycleInProject(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId, event: WorkbenchObservedLifecycleEvent) {
    projectId = this.canonicalProjectId(projectId);
    await this.getProject(projectId);
    return this.observeLifecycle(harness, threadId, event, projectId);
  }

  async observeLifecycle(harness: WorkbenchHarness, threadId: WorkbenchThreadId, event: WorkbenchObservedLifecycleEvent, selectedProjectId?: ProjectId) {
    if (selectedProjectId) selectedProjectId = this.canonicalProjectId(selectedProjectId);
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
        const pending = entry.pendingQuestionnaire?.requestKey === event.requestKey ? entry.pendingQuestionnaire : null;
        exactEvent = entry.lifecycle.kind === "needsAttention" && entry.lifecycle.reason === "pendingInput" && entry.lifecycle.requestKey === event.requestKey
          ? { ...event, turnId: entry.lifecycle.turnId }
          : event.answered && pending && entry.entryKind === "thread"
          ? { ...event, ...(pending.turnId ? { turnId: pending.turnId } : {}) }
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
      const heldQuestionnaire = this.heldQuestionnaire(existing, mutation);
      const next = parseWorkbenchThreadStateEntry({
        ...existing,
        ...(mutation.kind === "set" ? { pendingQuestionnaire: mutation.questionnaire } : shouldClear ? { pendingQuestionnaire: null } : {}),
        // Storing a question without an owning turn must still assert the wait that recovery reads.
        ...(heldQuestionnaire ? { lifecycle: this.waitOnQuestionnaire(existing.lifecycle, heldQuestionnaire) } : {}),
      });
      if (next.entryKind === "draft" || areDeeplyEqual(existing, next)) return existing;
      state.entries.set(key, next);
      await this.persist(projectId, state, [key]);
      this.publish(projectId, state, next);
      return next;
    });
  }

  async observeActivity(harness: WorkbenchHarness, threadId: WorkbenchThreadId, turnStartedAt?: number | null, selectedProjectId?: ProjectId) {
    if (selectedProjectId) selectedProjectId = this.canonicalProjectId(selectedProjectId);
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
        this.publish(projectId, state, next);
      });
    }
  }

  async observeDisplayLabel(harness: WorkbenchHarness, threadId: WorkbenchThreadId, label: string, selectedProjectId?: ProjectId) {
    const key = `${harness}:${threadId}`;
    const projects = selectedProjectId
      ? [[this.canonicalProjectId(selectedProjectId), await this.getProject(this.canonicalProjectId(selectedProjectId))] as const]
      : [...this.projects];
    for (const [projectId, state] of projects) {
      if (!state.entries.has(key)) continue;
      await this.enqueue(`${projectId}:thread:${key}`, async () => {
        const entry = state.entries.get(key);
        if (!entry || entry.entryKind === "draft") return;
        // A recorded explicit title owns display, so a provider label can never cover it.
        if (currentThreadTitleName(entry.titleHistory ?? [])) return;
        const title = resolveWorkbenchThreadTitle({ id: threadId, name: label, preview: entry.title });
        if (entry.title === title) return;
        state.entries.set(key, parseWorkbenchThreadStateEntry({ ...entry, title }));
        await this.persist(projectId, state, [key]);
        this.publish(projectId, state, state.entries.get(key));
      });
    }
  }

  async setTitle(projectId: ProjectId, harness: WorkbenchHarness, threadId: WorkbenchThreadId, title: string) {
    projectId = this.canonicalProjectId(projectId);
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
    const result = state.recordStore.setTitle(key, title, this.now());
    if (!result) return null;
    if (!result.changed) return result.next;
    await this.persist(projectId, state, [key]);
    this.publish(projectId, state, state.entries.get(key));
    return result.next;
  }

  private async dismissTitle(request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/title/dismiss" }>) {
    const state = await this.getProject(request.projectId);
    const key = `${request.identity.harness}:${request.identity.threadId}`;
    return await this.enqueue(`${request.projectId}:thread:${key}`, async () => {
      const result = state.recordStore.dismissTitle(key, request.title);
      if (!result) throw new Error("The thread is not available in the observed project.");
      if (result.changed) {
        await this.persist(request.projectId, state, [key]);
        this.publish(request.projectId, state, state.entries.get(key));
      }
      return { accepted: result.accepted };
    });
  }

  async getSnapshot(projectId: ProjectId) {
    projectId = this.canonicalProjectId(projectId);
    const state = await this.getProject(projectId);
    return this.snapshot(projectId, state);
  }

  async getThreadClaimContext(projectId: ProjectId, harness: WorkbenchHarnessId, threadId: WorkbenchThreadId): Promise<WorkbenchThreadClaimContext | null> {
    projectId = this.canonicalProjectId(projectId);
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
    projectId = this.canonicalProjectId(projectId);
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
    this.projectSubscribers.clear();
    this.waitingByThreadKey.clear();
    for (const state of this.projects.values()) {
      state.generation += 1;
      state.abort?.abort();
    }
    await this.archives.dispose();
    while (this.persistenceWrites.size) await Promise.allSettled([...this.persistenceWrites]);
  }

  private assertActive() {
    if (!this.active) throw this.retiredError;
  }

  async recordAcceptedSelection(selection: WorkbenchComposerProfileTargetSelection, at: number) {
    const results = await Promise.allSettled([
      selection.settings.model ? this.options.recordComposerModelUsage?.(
        selection.settings.harness, selection.settings.model, at,
      ) : undefined,
      selection.kind === "profile" ? this.options.recordComposerProfileUsage?.(selection.profileId, at) : undefined,
    ]);
    const failures = results.flatMap(result => result.status === "rejected" ? [sanitizeError(result.reason)] : []);
    if (failures.length) throw new Error(failures.join(" / "));
  }

  subscribeProjects(listener: (projectId: ProjectId) => void) {
    this.assertActive();
    this.projectSubscribers.add(listener);
    return () => { this.projectSubscribers.delete(listener); };
  }

  peekProject(projectId: ProjectId) {
    this.assertActive();
    projectId = this.canonicalProjectId(projectId);
    const state = this.projects.get(projectId);
    return state ? this.snapshot(projectId, state) : null;
  }

  async readProject(projectId: ProjectId) {
    projectId = this.canonicalProjectId(projectId);
    return this.snapshot(projectId, await this.getProject(projectId));
  }

  peekProjectSummary(projectId: ProjectId) {
    this.assertActive();
    projectId = this.canonicalProjectId(projectId);
    const state = this.projects.get(projectId);
    return state ? createWorkbenchProjectThreadSummary(
      projectId, this.naturallyOrderedEntries(state), state.revision, state.displayOrder,
    ) : null;
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
    projectId = this.canonicalProjectId(projectId);
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
        entries.set(`draft:${draft.draftId}`, projectWorkbenchThreadDraft(draft, {
          archived: false,
          pinned: pinned === true,
          snoozed: snoozed === true,
        }));
      }
      for (const record of stored.records) {
        entries.set(entryKey(record), record);
      }
      const state = new WorkbenchProjectThreadState({
        displayOrder: stored.displayOrder ?? {},
        drafts,
        entries,
        newThreadProfile: stored.newThreadProfile,
      });
      const originalEntries = new Map(state.entries);
      const repairedSettlementTimestamps = this.synchronizeSettlementTimestamps(state);
      this.projects.set(projectId, state);
      await this.pinnedLayout.importProject(projectId, this.naturallyOrderedEntries(state), state.displayOrder);
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

  async getProjectThreadSummary(projectId: ProjectId) {
    projectId = this.canonicalProjectId(projectId);
    const state = this.projects.get(projectId);
    if (state) {
      return createWorkbenchProjectThreadSummary(projectId, this.naturallyOrderedEntries(state), state.revision, state.displayOrder);
    }
    return this.options.threadStateStore.readNavigationSummary(projectId);
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

  async readWorkspaceThread(request: Pick<WorkbenchThreadObservationSnapshot, "projectId" | "subscriptionId" | "target">): Promise<WorkbenchThreadObservationSnapshot> {
    request = { ...request, projectId: this.canonicalProjectId(request.projectId) };
    const state = await this.getProject(request.projectId);
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
      version: 2,
    };
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
        const parsed = conformStoredWorkbenchThreadDraft(entry, projectId);
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
        : latestDraft ? workbenchComposerProfileFromDraft(latestDraft) : null,
      records,
      version: 4,
    };
  }

  private naturallyOrderedEntries(state: ProjectState) {
    const entries = [...state.entries.values()].flatMap((entry) => {
      const projected = projectWorkbenchThreadStateEntry(entry);
      if (!projected || projected.entryKind === "draft") return projected ? [projected] : [];
      const waitingFor = this.waitingByThreadKey.get(entryKey(projected));
      return [{
        ...projected,
        ...(waitingFor || (entry.entryKind === "thread" && entry.snoozedUntil) ? { waitingFor: waitingFor ?? "other" } : {}),
      }];
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
  private publish(projectId: ProjectId, state: ProjectState, changedEntry?: WorkbenchThreadStateEntry) {
    if (!this.active) return;
    state.revision += 1;
    for (const listener of this.projectSubscribers) {
      try { listener(projectId); }
      catch (error) { this.options.log?.(`Thread project observer failed: ${sanitizeError(error)}`); }
    }
    const projected = changedEntry ? projectWorkbenchThreadStateEntry(changedEntry) : null;
    if (projected) for (const listener of this.subscribers) listener(projectId, projected);
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
            const deferred = await this.options.pruneExpiredGitState(projectId, expiredRecords.map(({ identity }) => identity));
            const deferredKeys = new Set((Array.isArray(deferred) ? deferred : []).map(({ harness, threadId }) => `${harness}:${threadId}`));
            const gitHistoryCleanedAt = this.now();
            const cleanedKeys: string[] = [];
            for (const expired of expiredRecords) {
              if (deferredKeys.has(expired.key)) continue;
              const current = state.entries.get(expired.key);
              if (
                !current
                || current.entryKind === "draft"
                || !current.lifecycle.settled
                || current.settledAt !== expired.settledAt
              ) continue;
              state.entries.set(expired.key, { ...current, gitHistoryCleanedAt });
              cleanedKeys.push(expired.key);
            }
            if (cleanedKeys.length) await this.persist(projectId, state, cleanedKeys);
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
    const install = (key: string, entry: WorkbenchThreadStateEntry, workbenchTitle?: string) => {
      const existing = state.entries.get(key);
      if (entry.entryKind !== "draft") {
        const existingHistory = existing && existing.entryKind !== "draft" ? existing.titleHistory ?? [] : [];
        entry = {
          ...entry,
          titleHistory: recordThreadTitle(
            existingHistory,
            currentThreadTitleName(existingHistory) ?? "",
            workbenchTitle ?? "",
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
      const { workbenchTitle, ...sidebarEntry } = candidate;
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
        } : { ...providerEntry, mcpGeneration: null, providerObserved: true }), workbenchTitle);
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
      } : { ...providerEntry, mcpGeneration: null, providerObserved: true }), workbenchTitle);
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
    const next = previous.catch(() => undefined).then(() => {
      this.assertActive();
      return operation();
    });
    this.operationQueues.set(key, next);
    return next.finally(() => { if (this.operationQueues.get(key) === next) this.operationQueues.delete(key); });
  }

  private async mutatePriority(
    request: Extract<WorkbenchThreadStateRequest, { method: "workbench/thread-state/priority/set" }>,
  ) {
    const state = await this.getProject(request.projectId);
    return await this.enqueue(`${request.projectId}:thread:${request.sourceKey}`, async () => {
      const entry = state.entries.get(request.sourceKey);
      if (!entry) return { accepted: false, revision: state.revision };
      const next = setWorkbenchThreadEntryPriority(entry, request.priority);
      if (!next) return { accepted: false, revision: state.revision };
      if (areDeeplyEqual(entry, next)) return { accepted: true, revision: state.revision };
      const previousEntries = new Map(state.entries);
      state.entries.set(request.sourceKey, next);
      await this.persist(request.projectId, state, [request.sourceKey], { previousEntries, layout: true });
      this.publish(request.projectId, state, next);
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
      const currentTargets = source.snoozedUntil?.targets ?? [];
      const existingIndex = currentTargets.findIndex(wait => sameThreadTarget(
        wait.projectId, wait.identity, request.target.projectId, request.target.identity,
      ));
      const ready = existingIndex < 0 && this.isDependentSnoozeTargetReady(request.target.projectId, targetKey);
      const targets = existingIndex >= 0
        ? currentTargets.filter((_, index) => index !== existingIndex)
        : ready ? currentTargets
          : [...currentTargets, {
            ...request.target, title: currentThreadTitleName(target.titleHistory ?? []) ?? target.title,
          } satisfies WorkbenchThreadSnoozeTarget];
      const next = parseWorkbenchThreadStateEntry({
        ...source,
        metadata: { ...source.metadata, snoozed: targets.length > 0 },
        snoozedUntil: targets.length ? { targets } : null,
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
        && entry.snoozedUntil?.targets.some(wait => sameThreadTarget(
          wait.projectId, wait.identity, projectId, { harness: harness as WorkbenchHarnessId, threadId },
        ))
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
          || !current.snoozedUntil?.targets.some(wait => sameThreadTarget(
            wait.projectId, wait.identity, projectId, { harness: harness as WorkbenchHarnessId, threadId },
          ))
          || !this.isDependentSnoozeTargetReady(projectId, targetKey)
        ) return;
        const targets = current.snoozedUntil.targets.filter(wait => !sameThreadTarget(
          wait.projectId, wait.identity, projectId, { harness: harness as WorkbenchHarnessId, threadId },
        ));
        const next = parseWorkbenchThreadStateEntry({
          ...current,
          metadata: { ...current.metadata, snoozed: targets.length > 0 },
          snoozedUntil: targets.length ? { targets } : null,
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
        if (entry.entryKind !== "thread") continue;
        for (const target of entry.snoozedUntil?.targets ?? []) {
          const targetKey = `${target.identity.harness}:${target.identity.threadId}`;
          targets.set(`${target.projectId}\0${targetKey}`, { projectId: target.projectId, targetKey });
        }
      }
    }
    await Promise.all([...targets.values()].map(({ projectId, targetKey }) => (
      this.reevaluateDependentSnoozes(projectId, targetKey)
    )));
  }

  private async mutateThread(request: Exclude<WorkbenchThreadStateRequest, { method: "workbench/thread-state/priority/set" | "workbench/thread-state/snooze/until" }>) {
    const state = await this.getProject(request.projectId);
    const key = getThreadDisplayThreadKey(request.identity.harness, request.identity.threadId);
    const candidate = state.entries.get(key);
    const snoozingQuestionnaire = request.method === "workbench/thread-state/questionnaire/snooze";
    const snoozeQuestionnaire = snoozingQuestionnaire && candidate?.entryKind === "thread"
      && !candidate.metadata.archived
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
        entry.entryKind !== "thread" || entry.metadata.archived
        || entry.pendingQuestionnaire?.requestKey !== interruptedQuestionnaire.requestKey
        || entry.pendingQuestionnaire.itemId !== interruptedQuestionnaire.itemId
        || (entry.lifecycle.kind === "working"
          && getWorkbenchLifecycleTurnId(entry.lifecycle) !== getWorkbenchLifecycleTurnId(
            candidate && candidate.entryKind !== "draft" ? candidate.lifecycle : null,
          ))
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
        && await this.options.hasGitArcBlockingSettlement(request.projectId, entry.identity.harness, entry.identity.threadId)
      ) {
        return { accepted: false, revision: state.revision };
      }
      let next = entry;
      if (snoozeQuestionnaire && entry.entryKind === "thread") {
        next = {
          ...entry,
          lifecycle: { kind: "needsAttention", reason: "pendingInput", requestKey: snoozeQuestionnaire.requestKey, settled: false },
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
        ...(entry.entryKind === "thread" ? {
          snoozedUntil: null,
          ...(entry.metadata.archived ? { metadata: { archived: false as const, pinned: false, snoozed: false } } : {}),
          ...(!entry.metadata.archived && entry.snoozedUntil
            ? { metadata: { ...entry.metadata, snoozed: false } } : {}),
        } : {}),
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
      await this.persist(request.projectId, state, [key]); this.publish(request.projectId, state, state.entries.get(key));
      return { accepted: true, revision: state.revision };
    });
    const result = request.method === "workbench/thread-state/settle"
      ? await this.options.runGitArcReadTransition(request.projectId, mutate)
      : await mutate();
    await this.reevaluateDependentSnoozes(request.projectId, key);
    return result;
  }

  private changedEntryKeys(previous: ReadonlyMap<string, WorkbenchThreadStateEntry>, state: ProjectState) {
    return state.changedEntryKeys(previous);
  }

  private persist(
    projectId: ProjectId,
    state: ProjectState,
    keys: Iterable<string>,
    options: { previousEntries?: ReadonlyMap<string, WorkbenchThreadStateEntry>; layout?: boolean; profile?: boolean } = {},
  ) {
    return state.commit(projectId, keys, options, {
      beforeWrite: () => this.assertActive(),
      prepare: () => {
        this.synchronizeSettlementTimestamps(state);
        state.displayOrder = reconcileWorkbenchThreadDisplayOrder(
          this.naturallyOrderedEntries(state),
          state.displayOrder,
        );
      },
      write: async (changes) => {
        await this.options.threadStateStore.writeChanges(projectId, changes);
      this.archives.reschedule();
      },
    });
  }

  private writeSelectedState(
    projectId: ProjectId, state: ProjectState, keys: Iterable<string>,
    options: { layout?: boolean; profile?: boolean } = {},
  ) {
    return state.writeSelected(projectId, keys, options, {
      beforeWrite: () => this.assertActive(),
      write: async (changes) => {
        await this.options.threadStateStore.writeChanges(projectId, changes);
      },
    });
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
