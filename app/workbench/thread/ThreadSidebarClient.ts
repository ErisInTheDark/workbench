/*
 * Exports:
 * - ThreadSidebarOpenResult: project observation bootstrap.
 * - ThreadSidebarGlobalOpenResult: global observation bootstrap.
 * - ThreadSidebarTransport: observation and draft mutation ports.
 * - ThreadSidebarClientOptions: transport and snapshot callback.
 * - ThreadSidebarAcceptedIntent: provider-confirmed local admission.
 * - default ThreadSidebarClient: project/global sidebar state and project-qualified draft save queues.
 */
import type { WorkbenchThreadSidebarStore } from "workbench-shared/types";
import { findWorkbenchThreadFolder, moveWorkbenchThreadDisplayItem, replaceWorkbenchThreadFolderMember, resolveWorkbenchThreadDisplayOrder, sortThreadSidebarEntries } from "workbench-shared/workbench/thread/thread-display-order";
import { createDraftTitle, type WorkbenchHarnessId, type WorkbenchHomeThreadDisplayOrderSnapshot, type WorkbenchPinnedThreadLayoutSnapshot, type WorkbenchProjectThreadSidebars, type WorkbenchProjectThreadSidebarUpdate, type WorkbenchProjectThreadSummaries, type WorkbenchProjectThreadSummary, type WorkbenchProjectThreadSummaryUpdate, type WorkbenchThreadActivityUpdate, type WorkbenchThreadDraft, type WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";
import ThreadSidebarProjectState from "./ThreadSidebarProjectState";
import type { DraftId, FolderId, ProjectId, WorkbenchThreadId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import { getThreadDisplayDraftKey, getThreadDisplayThreadKey } from "workbench-shared/workbench/thread/thread-display-layout";

export interface ThreadSidebarOpenResult {
  pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshot;
  projectThreads: WorkbenchProjectThreadSummaries;
  sidebar: WorkbenchThreadSidebarSnapshot;
}

export interface ThreadSidebarGlobalOpenResult {
  homeThreadDisplayOrder: WorkbenchHomeThreadDisplayOrderSnapshot | null;
  pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshot;
  projectSidebars: WorkbenchProjectThreadSidebars;
}

export interface ThreadSidebarTransport {
  close(projectId: ProjectId): Promise<void>;
  closeGlobal?(): Promise<void>;
  deleteDraft(projectId: ProjectId, draftId: DraftId, clientUpdatedAt: number): Promise<void>;
  moveDraft?(sourceProjectId: ProjectId, destinationProjectId: ProjectId, draftId: DraftId): Promise<void>;
  open(projectId: ProjectId): Promise<ThreadSidebarOpenResult | WorkbenchThreadSidebarSnapshot>;
  openGlobal?(): Promise<ThreadSidebarGlobalOpenResult>;
  upsertDraft(projectId: ProjectId, draft: WorkbenchThreadDraft, folderId?: FolderId): Promise<void>;
}
export interface ThreadSidebarClientOptions {
  onChange: (snapshot: WorkbenchThreadSidebarSnapshot | null) => void;
  transport: ThreadSidebarTransport;
}
export interface ThreadSidebarAcceptedIntent {
  activityAt?: number;
  draftId?: DraftId;
  identity: { harness: WorkbenchHarnessId; threadId: WorkbenchThreadId };
  projectId?: ProjectId;
  title: string;
  turnId: WorkbenchTurnId;
}

interface DraftQueue {
  // Observation can disappear while an originating form still has edits or image reads.
  draft: WorkbenchThreadDraft | null;
  savedDraft: WorkbenchThreadDraft | null;
  folderId: FolderId | null;
  inFlight: Promise<void> | null;
  projectId: ProjectId;
  retired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export default class ThreadSidebarClient implements WorkbenchThreadSidebarStore {
  private isOpen = false;
  private homeThreadDisplayOrder: WorkbenchHomeThreadDisplayOrderSnapshot = { displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder" };
  private homeThreadDisplayOrderSupported = false;
  private mode: "closed" | "global" | "project" = "closed";
  private pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshot = { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" };
  private projectId: ProjectId | null = null;
  private projectThreadSidebars: WorkbenchProjectThreadSidebars = { projects: [] };
  private projectThreadSummaries: WorkbenchProjectThreadSummaries = { projects: [] };
  private readonly projects = new Map<ProjectId, ThreadSidebarProjectState>();
  private readonly listeners = new Set<() => void>();
  private readonly queues = new Map<string, DraftQueue>();
  constructor(private readonly options: ThreadSidebarClientOptions) {}

  readonly getSnapshot = () => this.projectId ? this.getProjectSnapshot(this.projectId) : null;
  readonly getHomeThreadDisplayOrder = () => this.homeThreadDisplayOrder;
  readonly getHomeThreadDisplayOrderSupported = () => this.homeThreadDisplayOrderSupported;
  readonly getPinnedThreadLayout = () => this.pinnedThreadLayout;
  readonly getProjectSnapshot = (projectId: ProjectId) => this.projectThreadSidebars.projects.find((snapshot) => snapshot.projectId === projectId) ?? null;
  readonly getDraft = (projectId: ProjectId, draftId: DraftId): WorkbenchThreadDraft | null => {
    const queue = this.queues.get(this.queueKey(projectId, draftId));
    if (queue) return queue.retired ? null : queue.draft;
    const entry = this.getProjectSnapshot(projectId)?.entries.find((entry) => entry.entryKind === "draft" && entry.draft.draftId === draftId);
    return entry?.entryKind === "draft" ? entry.draft : null;
  };
  readonly getProjectThreadSidebars = () => this.projectThreadSidebars;
  readonly getProjectThreadSummaries = () => this.projectThreadSummaries;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async open(projectId: ProjectId) {
    if (this.mode === "project" && this.projectId === projectId && this.getSnapshot() && this.isOpen) return true;
    if (this.mode !== "closed") await this.close();
    this.mode = "project";
    this.projectId = projectId;
    this.isOpen = false;
    this.clearProjects();
    this.publish();
    try {
      this.installOpenResult(await this.options.transport.open(projectId));
      this.isOpen = true;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open the thread sidebar.";
      this.install({ entries: [], error: message.slice(0, 500), freshness: "partial", projectId, revision: 0 });
      return false;
    }
  }
  async openGlobal() {
    if (this.mode === "global" && this.isOpen) return true;
    if (this.mode !== "closed") await this.close();
    this.mode = "global";
    this.projectId = null;
    this.homeThreadDisplayOrderSupported = false;
    this.clearProjects();
    this.publish();
    try {
      if (!this.options.transport.openGlobal) throw new Error("Global thread observation is unavailable.");
      const result = await this.options.transport.openGlobal();
      this.homeThreadDisplayOrder = result.homeThreadDisplayOrder ?? { displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder" };
      this.homeThreadDisplayOrderSupported = Boolean(result.homeThreadDisplayOrder);
      this.pinnedThreadLayout = result.pinnedThreadLayout;
      for (const sidebar of result.projectSidebars.projects) this.installProjectSidebar(sidebar);
      this.isOpen = true;
      this.publish();
      return true;
    } catch (error) {
      this.mode = "closed";
      this.isOpen = false;
      this.homeThreadDisplayOrderSupported = false;
      this.clearProjects();
      this.publish();
      throw error;
    }
  }
  accept(snapshot: WorkbenchThreadSidebarSnapshot) {
    if (this.mode === "global") {
      if (this.installProjectSidebar(snapshot)) this.publish();
      return;
    }
    if (snapshot.projectId === this.projectId) this.install(snapshot);
  }
  acceptProjectThreadSidebar(update: WorkbenchProjectThreadSidebarUpdate) {
    if (this.mode === "global" && this.installProjectSidebar(update.sidebar)) this.publish();
  }
  acceptHomeThreadDisplayOrder(update: WorkbenchHomeThreadDisplayOrderSnapshot) {
    if (this.mode !== "global" || update.revision <= this.homeThreadDisplayOrder.revision) return;
    this.homeThreadDisplayOrder = update;
    this.homeThreadDisplayOrderSupported = true;
    this.publish();
  }
  acceptProjectThreadSummaries(snapshot: WorkbenchProjectThreadSummaries) {
    const changed = snapshot.projects.reduce((didChange, summary) => this.setProjectThreadSummary(summary) || didChange, false);
    if (changed) this.publish();
  }
  acceptProjectThreadSummary(update: WorkbenchProjectThreadSummaryUpdate) {
    if (this.setProjectThreadSummary(update.summary)) this.publish();
  }
  acceptPinnedThreadLayout(update: WorkbenchPinnedThreadLayoutSnapshot) {
    if (update.revision <= this.pinnedThreadLayout.revision) return;
    this.pinnedThreadLayout = update;
    this.publish();
  }
  acceptActivity(update: WorkbenchThreadActivityUpdate) {
    if (this.mode !== "global" && (this.mode !== "project" || update.projectId !== this.projectId)) return;
    if (!this.projectState(update.projectId).acceptActivity(update)) return;
    this.syncProjectViews();
    this.publish();
  }
  acceptDelta(update: import("workbench-shared/workbench/thread/thread-state").WorkbenchThreadStateDelta) {
    if (this.mode !== "global" && (this.mode !== "project" || update.projectId !== this.projectId)) return;
    for (const entry of update.upserts) if (entry.entryKind === "draft") this.receiveDraft(entry.draft);
    if (!this.projectState(update.projectId).acceptDelta(update)) return;
    this.syncProjectViews();
    this.publish();
  }
  receiveDraft(draft: WorkbenchThreadDraft) {
    const key = this.queueKey(draft.projectId, draft.draftId);
    const queue = this.queues.get(key);
    if (!queue) {
      this.queues.set(key, { draft, savedDraft: draft, folderId: null, inFlight: null, projectId: draft.projectId, retired: false, timer: null });
    } else if (!queue.retired && !queue.inFlight && queue.draft === queue.savedDraft
      && (!queue.draft || draft.clientUpdatedAt >= queue.draft.clientUpdatedAt)) {
      queue.draft = draft;
      queue.savedDraft = draft;
    }
  }
  edit(draft: WorkbenchThreadDraft, options: { folderId?: FolderId } = {}) {
    const queueKey = this.queueKey(draft.projectId, draft.draftId);
    const queue = this.queues.get(queueKey) ?? { draft: null, savedDraft: null, folderId: null, inFlight: null, projectId: draft.projectId, retired: false, timer: null };
    if (queue.retired) return;
    if (options.folderId) queue.folderId = options.folderId;
    queue.draft = draft;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => {
      queue.timer = null;
      void this.flushQueue(queueKey, queue).catch(() => undefined);
    }, 500);
    this.queues.set(queueKey, queue);
    this.installOptimisticDraft(draft, queue.folderId);
  }
  acceptIntent(intent: ThreadSidebarAcceptedIntent) {
    const projectId = intent.projectId ?? this.projectId ?? (intent.draftId ? this.findDraftProjectId(intent.draftId) : null);
    const queueKey = intent.draftId && projectId ? this.queueKey(projectId, intent.draftId) : null;
    const queue = queueKey ? this.queues.get(queueKey) : null;
    if (queue?.timer) clearTimeout(queue.timer);
    if (queue) {
      queue.draft = null;
      queue.retired = true;
      queue.timer = null;
    }
    const inFlight = queue?.inFlight?.catch(() => undefined) ?? Promise.resolve();
    if (intent.draftId && queue) {
      void inFlight.finally(() => {
        if (queueKey && this.queues.get(queueKey) === queue) this.queues.delete(queueKey);
      });
    }
    const current = projectId ? this.getProjectSidebar(projectId) : null;
    if (current) {
      const activityAt = intent.activityAt ?? Date.now();
      const existing = current.entries.find((entry) => entry.entryKind === "thread"
        && entry.identity.harness === intent.identity.harness
        && entry.identity.threadId === intent.identity.threadId);
      const sourceDraft = intent.draftId
        ? current.entries.find((entry) => entry.entryKind === "draft" && entry.draft.draftId === intent.draftId)
        : null;
      const entry = {
        activityAt,
        entryKind: "thread" as const,
        identity: intent.identity,
        lifecycle: { agent: { agentStatus: "working" as const, turnId: intent.turnId }, kind: "working" as const, reason: "acceptedIntent" as const, settled: false as const },
        metadata: existing?.entryKind === "thread"
          ? existing.metadata.archived
            ? { archived: true as const, pinned: false as const, snoozed: false as const }
            : { archived: false as const, pinned: existing.metadata.pinned, snoozed: false as const }
          : { archived: false as const, pinned: sourceDraft?.entryKind === "draft" ? sourceDraft.metadata.pinned : false, snoozed: false },
        orderAt: activityAt,
        title: existing?.entryKind === "thread" ? existing.title : intent.title,
      };
      const displayOrder = intent.draftId
        ? replaceWorkbenchThreadFolderMember(current.displayOrder, getThreadDisplayDraftKey(intent.draftId), getThreadDisplayThreadKey(intent.identity.harness, intent.identity.threadId))
        : current.displayOrder;
      const resolved = resolveWorkbenchThreadDisplayOrder([
          ...current.entries.filter((candidate) => {
            if (candidate.entryKind === "draft") return candidate.draft.draftId !== intent.draftId;
            if (candidate.entryKind === "subagent") return true;
            return candidate.identity.harness !== intent.identity.harness || candidate.identity.threadId !== intent.identity.threadId;
          }),
          entry,
        ], displayOrder);
      this.replaceProjectSidebar({ ...current, ...resolved });
      this.syncProjectThreadSummary({ ...current, ...resolved });
      this.publish();
    }
    return inFlight;
  }
  async delete(draftId: DraftId, clientUpdatedAt = Date.now(), projectId = this.projectId ?? this.findDraftProjectId(draftId)) {
    if (!projectId) return;
    const queueKey = this.queueKey(projectId, draftId);
    const queue = this.queues.get(queueKey);
    if (queue?.timer) clearTimeout(queue.timer);
    if (queue) { queue.timer = null; queue.retired = true; }
    try {
      if (queue) await queue.inFlight;
      await this.options.transport.deleteDraft(projectId, draftId, clientUpdatedAt);
    } catch (error) {
      if (queue) queue.retired = false;
      throw error;
    }
    this.queues.delete(queueKey);
    const current = this.getProjectSidebar(projectId);
    if (current) {
      const resolved = resolveWorkbenchThreadDisplayOrder(
        current.entries.filter((entry) => entry.entryKind !== "draft" || entry.draft.draftId !== draftId),
        current.displayOrder,
      );
      this.replaceProjectSidebar({ ...current, ...resolved });
      this.publish();
    }
  }
  async moveDraft(sourceProjectId: ProjectId, destinationProjectId: ProjectId, draftId: DraftId) {
    const queueKey = this.queueKey(sourceProjectId, draftId);
    const queue = this.queues.get(queueKey);
    if (queue) await this.flushQueue(queueKey, queue);
    const destinationQueueKey = this.queueKey(destinationProjectId, draftId);
    const destinationQueue = this.queues.get(destinationQueueKey);
    if (destinationQueue && destinationQueue !== queue) await this.flushQueue(destinationQueueKey, destinationQueue);
    const sourceDraft = this.getDraft(sourceProjectId, draftId);
    if (!this.options.transport.moveDraft) throw new Error("Draft moves are unavailable.");
    await this.options.transport.moveDraft(sourceProjectId, destinationProjectId, draftId);
    this.queues.delete(queueKey);
    this.queues.delete(destinationQueueKey);
    if (sourceDraft) this.receiveDraft({ ...sourceDraft, projectId: destinationProjectId });

    const source = this.getProjectSidebar(sourceProjectId);
    const destination = this.getProjectSidebar(destinationProjectId);
    const sourceEntry = source?.entries.find((entry) => entry.entryKind === "draft" && entry.draft.draftId === draftId);
    if (!source || !destination || sourceEntry?.entryKind !== "draft") return;
    const movedEntry = {
      ...sourceEntry,
      draft: { ...sourceEntry.draft, projectId: destinationProjectId },
    };
    const resolvedSource = resolveWorkbenchThreadDisplayOrder(
      source.entries.filter((entry) => entry.entryKind !== "draft" || entry.draft.draftId !== draftId),
      source.displayOrder,
    );
    const resolvedDestination = resolveWorkbenchThreadDisplayOrder(
      [...destination.entries.filter((entry) => entry.entryKind !== "draft" || entry.draft.draftId !== draftId), movedEntry],
      destination.displayOrder,
    );
    this.replaceProjectSidebar({ ...source, ...resolvedSource });
    this.replaceProjectSidebar({ ...destination, ...resolvedDestination });
    this.publish();
  }
  async flush() { for (const [id, queue] of this.queues) await this.flushQueue(id, queue); }
  async flushDraft(projectId: ProjectId, draftId: DraftId) {
    const id = this.queueKey(projectId, draftId);
    const queue = this.queues.get(id);
    if (queue) await this.flushQueue(id, queue);
  }
  async guardNavigation(action: () => void | Promise<void>) { await this.flush(); await action(); }
  bestEffortFlush() { void this.flush().catch(() => undefined); }
  async reopen() {
    if (this.mode === "global") {
      if (!this.options.transport.openGlobal) throw new Error("Global thread observation is unavailable.");
      for (const state of this.projects.values()) state.resetAdmission();
      const result = await this.options.transport.openGlobal();
      for (const [projectId, state] of this.projects) {
        if (!state.hasAdmission() && !result.projectSidebars.projects.some((sidebar) => sidebar.projectId === projectId)) {
          this.projects.delete(projectId);
        }
      }
      this.homeThreadDisplayOrder = result.homeThreadDisplayOrder ?? { displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder" };
      this.homeThreadDisplayOrderSupported = Boolean(result.homeThreadDisplayOrder);
      this.pinnedThreadLayout = result.pinnedThreadLayout;
      for (const sidebar of result.projectSidebars.projects) this.installProjectSidebar(sidebar);
      this.syncProjectViews();
      this.publish();
      return;
    }
    if (this.mode === "project" && this.projectId) {
      for (const state of this.projects.values()) state.resetAdmission();
      this.installOpenResult(await this.options.transport.open(this.projectId));
    }
  }
  async close() {
    await this.flush();
    if (this.mode === "closed") return;
    const mode = this.mode;
    const projectId = this.projectId;
    this.mode = "closed";
    this.projectId = null;
    this.isOpen = false;
    this.homeThreadDisplayOrderSupported = false;
    this.clearProjects();
    this.publish();
    const close = mode === "global"
      ? this.options.transport.closeGlobal?.() ?? Promise.resolve()
      : projectId ? this.options.transport.close(projectId) : Promise.resolve();
    await close.catch((error: unknown) => {
      console.warn("Unable to close the thread sidebar observation.", error);
    });
  }
  private install(snapshot: WorkbenchThreadSidebarSnapshot) {
    if (this.installProjectSidebar(snapshot)) this.publish();
  }
  private installOpenResult(result: ThreadSidebarOpenResult | WorkbenchThreadSidebarSnapshot) {
    let changed = false;
    if ("sidebar" in result) {
      if (result.pinnedThreadLayout.revision > this.pinnedThreadLayout.revision) {
        this.pinnedThreadLayout = result.pinnedThreadLayout;
        changed = true;
      }
      for (const summary of result.projectThreads.projects) changed = this.setProjectThreadSummary(summary) || changed;
    }
    changed = this.installProjectSidebar("sidebar" in result ? result.sidebar : result) || changed;
    if (changed) this.publish();
  }
  private setProjectThreadSummary(summary: WorkbenchProjectThreadSummary) {
    const changed = this.projectState(summary.projectId).acceptSummary(summary);
    if (changed) this.syncProjectViews();
    return changed;
  }
  private syncProjectThreadSummary(snapshot: WorkbenchThreadSidebarSnapshot) {
    this.projectState(snapshot.projectId).syncSummary();
    this.syncProjectViews();
  }
  private installProjectSidebar(snapshot: WorkbenchThreadSidebarSnapshot) {
    const state = this.projectState(snapshot.projectId);
    if (!state.acceptSidebar(snapshot)) return false;
    for (const entry of state.getSnapshot()!.entries) {
      if (entry.entryKind === "draft") this.receiveDraft(entry.draft);
    }
    this.syncProjectViews();
    return true;
  }
  private replaceProjectSidebar(snapshot: WorkbenchThreadSidebarSnapshot) {
    for (const entry of snapshot.entries) {
      if (entry.entryKind === "draft") this.receiveDraft(entry.draft);
    }
    this.projectState(snapshot.projectId).replaceLocalSidebar(snapshot);
    this.syncProjectViews();
  }
  private projectState(projectId: ProjectId) {
    let state = this.projects.get(projectId);
    if (!state) {
      state = new ThreadSidebarProjectState();
      this.projects.set(projectId, state);
    }
    return state;
  }
  private clearProjects() {
    this.projects.clear();
    this.projectThreadSidebars = { projects: [] };
    this.projectThreadSummaries = { projects: [] };
  }
  private syncProjectViews() {
    const sidebars = [...this.projects.values()].flatMap((state) => state.getSnapshot() ?? []);
    const summaries = [...this.projects.values()].flatMap((state) => state.getSummary() ?? []);
    if (sidebars.length !== this.projectThreadSidebars.projects.length
      || sidebars.some((sidebar, index) => sidebar !== this.projectThreadSidebars.projects[index])) {
      this.projectThreadSidebars = { projects: sidebars };
    }
    if (summaries.length !== this.projectThreadSummaries.projects.length
      || summaries.some((summary, index) => summary !== this.projectThreadSummaries.projects[index])) {
      this.projectThreadSummaries = { projects: summaries };
    }
  }
  private getProjectSidebar(projectId: ProjectId) {
    return this.getProjectSnapshot(projectId);
  }
  private findDraftProjectId(draftId: DraftId) {
    return [...this.queues.values()].find((queue) => !queue.retired && queue.draft?.draftId === draftId)?.projectId
      ?? this.projectThreadSidebars.projects.find(({ entries }) => entries.some((entry) => (
      entry.entryKind === "draft" && entry.draft.draftId === draftId
    )))?.projectId ?? null;
  }
  private queueKey(projectId: ProjectId, draftId: DraftId) {
    return `${encodeURIComponent(projectId)}:${draftId}`;
  }
  private installOptimisticDraft(draft: WorkbenchThreadDraft, folderId: FolderId | null) {
    const current = this.getProjectSidebar(draft.projectId);
    if (!current) return;
    const existing = current.entries.find((entry) => entry.entryKind === "draft" && entry.draft.draftId === draft.draftId);
    const currentFolder = findWorkbenchThreadFolder(current.displayOrder, getThreadDisplayDraftKey(draft.draftId));
    const targetFolder = folderId ? current.displayOrder?.folders?.find((candidate) => candidate.folderId === folderId) : null;
    const entry = {
      activityAt: draft.updatedAt,
      draft,
      entryKind: "draft" as const,
      metadata: existing?.entryKind === "draft"
        ? existing.metadata
        : { archived: false as const, pinned: targetFolder?.section === "pinned", snoozed: targetFolder?.section === "snoozed" },
      title: createDraftTitle(draft.prompt),
    };
    const entries = [
        ...current.entries.filter((candidate) => candidate.entryKind !== "draft" || candidate.draft.draftId !== draft.draftId),
        entry,
      ];
    const displayOrder = targetFolder && currentFolder?.folderId !== targetFolder.folderId
      ? moveWorkbenchThreadDisplayItem(sortThreadSidebarEntries(entries), current.displayOrder, targetFolder.section, getThreadDisplayDraftKey(draft.draftId), targetFolder.folderId, targetFolder.threadKeys[0] ?? null) ?? current.displayOrder
      : current.displayOrder;
    const resolved = resolveWorkbenchThreadDisplayOrder(entries, displayOrder);
    this.replaceProjectSidebar({ ...current, ...resolved });
    this.publish();
  }
  private async flushQueue(id: string, queue: DraftQueue) {
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    if (queue.inFlight) await queue.inFlight;
    if (queue.retired) return;
    const draft = queue.draft; const projectId = queue.projectId;
    if (!draft || draft === queue.savedDraft) return;
    const folderId = queue.folderId ?? undefined;
    queue.inFlight = this.options.transport.upsertDraft(projectId, draft, folderId).then(() => {
      queue.savedDraft = draft;
      if (queue.folderId === folderId) queue.folderId = null;
    }).finally(() => { queue.inFlight = null; });
    try {
      await queue.inFlight;
      const current = this.getProjectSidebar(projectId);
      const observed = current?.entries.find((entry) => entry.entryKind === "draft" && entry.draft.draftId === draft.draftId);
      if (observed?.entryKind === "draft") this.receiveDraft(observed.draft);
      if (current?.error?.startsWith("Draft save failed:")) {
        this.replaceProjectSidebar({ ...current, error: null });
        this.publish();
      }
    } catch (error) {
      if (queue.retired) return;
      const current = this.getProjectSidebar(projectId);
      const message = error instanceof Error ? error.message : "Unable to save this draft.";
      if (current) {
        this.replaceProjectSidebar({ ...current, error: `Draft save failed: ${message}`.slice(0, 500), freshness: "partial" });
        this.publish();
      } else {
        console.error("Unable to save the detached draft.", message.slice(0, 500));
      }
      const retryDraft = queue.draft;
      if (retryDraft) this.edit(retryDraft);
      throw error;
    }
    if (queue.draft !== queue.savedDraft) await this.flushQueue(id, queue);
  }
  private publish() {
    this.options.onChange(this.getSnapshot());
    for (const listener of this.listeners) listener();
  }
}
