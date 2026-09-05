/*
 * Keywords: sidebar, project, pinned, drafts, debounce, flush, observation.
 * Exports:
 * - ThreadSidebarOpenResult: project observation bootstrap.
 * - ThreadSidebarGlobalOpenResult: global observation bootstrap.
 * - ThreadSidebarTransport: observation and draft mutation ports.
 * - ThreadSidebarClientOptions: transport and snapshot callback.
 * - ThreadSidebarAcceptedIntent: provider-confirmed local admission.
 * - default ThreadSidebarClient: project/global sidebar state and project-qualified draft save queues.
 */
import type { WorkbenchThreadSidebarStore } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { findWorkbenchThreadFolder, moveWorkbenchThreadDisplayItem, replaceWorkbenchThreadFolderMember, resolveWorkbenchThreadDisplayOrder, sortThreadSidebarEntries } from "workbench-shared/workbench/thread/thread-display-order";
import { createDraftTitle, createWorkbenchProjectThreadSummary, type WorkbenchHarnessId, type WorkbenchHomeThreadDisplayOrderSnapshot, type WorkbenchPinnedThreadLayoutSnapshot, type WorkbenchProjectThreadSidebars, type WorkbenchProjectThreadSidebarUpdate, type WorkbenchProjectThreadSummaries, type WorkbenchProjectThreadSummary, type WorkbenchProjectThreadSummaryUpdate, type WorkbenchThreadActivityUpdate, type WorkbenchThreadDraft, type WorkbenchThreadSidebarSnapshot } from "workbench-shared/workbench/thread/thread-state";

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
  close(projectId: string): Promise<void>;
  closeGlobal?(): Promise<void>;
  deleteDraft(projectId: string, draftId: string, clientUpdatedAt: number): Promise<void>;
  moveDraft?(sourceProjectId: string, destinationProjectId: string, draftId: string): Promise<void>;
  open(projectId: string): Promise<ThreadSidebarOpenResult | WorkbenchThreadSidebarSnapshot>;
  openGlobal?(): Promise<ThreadSidebarGlobalOpenResult>;
  upsertDraft(projectId: string, draft: WorkbenchThreadDraft, folderId?: string): Promise<void>;
}
export interface ThreadSidebarClientOptions {
  onChange: (snapshot: WorkbenchThreadSidebarSnapshot | null) => void;
  transport: ThreadSidebarTransport;
}
export interface ThreadSidebarAcceptedIntent {
  activityAt?: number;
  draftId?: string;
  identity: { harness: WorkbenchHarnessId; threadId: string };
  projectId?: string;
  title: string;
  turnId: string;
}

interface DraftQueue {
  draft: WorkbenchThreadDraft | null;
  folderId: string | null;
  inFlight: Promise<void> | null;
  projectId: string;
  retired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export default class ThreadSidebarClient implements WorkbenchThreadSidebarStore {
  private isOpen = false;
  private homeThreadDisplayOrder: WorkbenchHomeThreadDisplayOrderSnapshot = { displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder" };
  private homeThreadDisplayOrderSupported = false;
  private mode: "closed" | "global" | "project" = "closed";
  private pinnedThreadLayout: WorkbenchPinnedThreadLayoutSnapshot = { displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout" };
  private projectId: string | null = null;
  private projectThreadSidebars: WorkbenchProjectThreadSidebars = { projects: [] };
  private projectThreadSummaries: WorkbenchProjectThreadSummaries = { projects: [] };
  private revision = -1;
  private snapshot: WorkbenchThreadSidebarSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly queues = new Map<string, DraftQueue>();
  constructor(private readonly options: ThreadSidebarClientOptions) {}

  readonly getSnapshot = () => this.snapshot;
  readonly getHomeThreadDisplayOrder = () => this.homeThreadDisplayOrder;
  readonly getHomeThreadDisplayOrderSupported = () => this.homeThreadDisplayOrderSupported;
  readonly getPinnedThreadLayout = () => this.pinnedThreadLayout;
  readonly getProjectSnapshot = (projectId: string) => this.projectThreadSidebars.projects.find((snapshot) => snapshot.projectId === projectId) ?? null;
  readonly getProjectThreadSidebars = () => this.projectThreadSidebars;
  readonly getProjectThreadSummaries = () => this.projectThreadSummaries;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async open(projectId: string) {
    if (this.mode === "project" && this.projectId === projectId && this.snapshot && this.isOpen) return true;
    if (this.mode !== "closed") await this.close();
    this.mode = "project";
    this.projectId = projectId;
    this.isOpen = false;
    this.revision = -1;
    this.projectThreadSummaries = { projects: [] };
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
    this.snapshot = null;
    this.homeThreadDisplayOrderSupported = false;
    this.revision = -1;
    this.projectThreadSidebars = { projects: [] };
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
      this.projectThreadSidebars = { projects: [] };
      this.projectThreadSummaries = { projects: [] };
      this.publish();
      throw error;
    }
  }
  accept(snapshot: WorkbenchThreadSidebarSnapshot) {
    if (this.mode === "global") {
      if (this.installProjectSidebar(snapshot)) this.publish();
      return;
    }
    if (snapshot.projectId === this.projectId && snapshot.revision > this.revision) this.install(snapshot);
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
    const current = this.mode === "global"
      ? this.projectThreadSidebars.projects.find(({ projectId }) => projectId === update.projectId) ?? null
      : update.projectId === this.projectId ? this.snapshot : null;
    if (!current || update.revision <= current.revision) return;
    const entries = current.entries.map((entry) => entry.entryKind !== "draft" && entry.identity.harness === update.identity.harness && entry.identity.threadId === update.identity.threadId
      ? entry.entryKind === "thread" && update.orderAt !== undefined
        ? { ...entry, activityAt: update.activityAt, orderAt: update.orderAt }
        : { ...entry, activityAt: update.activityAt }
      : entry);
    const resolved = resolveWorkbenchThreadDisplayOrder(entries, update.displayOrder ?? current.displayOrder);
    const next = { ...current, ...resolved, revision: update.revision };
    if (this.mode === "global") this.replaceProjectSidebar(next);
    else {
      this.revision = update.revision;
      this.snapshot = next;
    }
    this.syncProjectThreadSummary(next);
    this.publish();
  }
  edit(draft: WorkbenchThreadDraft, options: { folderId?: string } = {}) {
    if (this.mode === "project" && draft.projectId !== this.projectId) throw new Error("The draft does not belong to the observed project.");
    if (this.mode === "closed") throw new Error("The draft sidebar is not observed.");
    const queueKey = this.queueKey(draft.projectId, draft.draftId);
    const queue = this.queues.get(queueKey) ?? { draft: null, folderId: null, inFlight: null, projectId: draft.projectId, retired: false, timer: null };
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
        ? replaceWorkbenchThreadFolderMember(current.displayOrder, `draft:${intent.draftId}`, `${intent.identity.harness}:${intent.identity.threadId}`)
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
  async delete(draftId: string, clientUpdatedAt = Date.now(), projectId = this.projectId ?? this.findDraftProjectId(draftId)) {
    if (!projectId) return;
    const queueKey = this.queueKey(projectId, draftId);
    const queue = this.queues.get(queueKey);
    if (queue?.timer) clearTimeout(queue.timer);
    if (queue) { queue.timer = null; queue.draft = null; await queue.inFlight; }
    await this.options.transport.deleteDraft(projectId, draftId, clientUpdatedAt);
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
  async moveDraft(sourceProjectId: string, destinationProjectId: string, draftId: string) {
    const queueKey = this.queueKey(sourceProjectId, draftId);
    const queue = this.queues.get(queueKey);
    if (queue) await this.flushQueue(queueKey, queue);
    if (!this.options.transport.moveDraft) throw new Error("Draft moves are unavailable.");
    await this.options.transport.moveDraft(sourceProjectId, destinationProjectId, draftId);
    this.queues.delete(queueKey);

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
  async flushDraft(projectId: string, draftId: string) {
    const id = this.queueKey(projectId, draftId);
    const queue = this.queues.get(id);
    if (queue) await this.flushQueue(id, queue);
  }
  async guardNavigation(action: () => void | Promise<void>) { await this.flush(); await action(); }
  bestEffortFlush() { void this.flush().catch(() => undefined); }
  async reopen() {
    if (this.mode === "global") {
      if (!this.options.transport.openGlobal) throw new Error("Global thread observation is unavailable.");
      const result = await this.options.transport.openGlobal();
      this.homeThreadDisplayOrder = result.homeThreadDisplayOrder ?? { displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder" };
      this.homeThreadDisplayOrderSupported = Boolean(result.homeThreadDisplayOrder);
      this.pinnedThreadLayout = result.pinnedThreadLayout;
      this.projectThreadSidebars = { projects: [] };
      for (const sidebar of result.projectSidebars.projects) this.installProjectSidebar(sidebar);
      this.publish();
      return;
    }
    if (this.mode === "project" && this.projectId) {
      this.revision = -1;
      this.installOpenResult(await this.options.transport.open(this.projectId));
    }
  }
  async close() {
    if (this.mode === "closed") return;
    await this.flush();
    const mode = this.mode;
    const projectId = this.projectId;
    this.mode = "closed";
    this.projectId = null;
    this.isOpen = false;
    this.snapshot = null;
    this.homeThreadDisplayOrderSupported = false;
    this.projectThreadSidebars = { projects: [] };
    this.publish();
    const close = mode === "global"
      ? this.options.transport.closeGlobal?.() ?? Promise.resolve()
      : projectId ? this.options.transport.close(projectId) : Promise.resolve();
    await close.catch((error: unknown) => {
      console.warn("Unable to close the thread sidebar observation.", error);
    });
  }
  private install(snapshot: WorkbenchThreadSidebarSnapshot) {
    if (snapshot.revision <= this.revision) return;
    this.revision = snapshot.revision;
    this.snapshot = { ...snapshot, ...resolveWorkbenchThreadDisplayOrder(snapshot.entries, snapshot.displayOrder) };
    this.replaceProjectSidebar(this.snapshot);
    this.syncSelectedProjectThreadSummary();
    this.publish();
  }
  private installOpenResult(result: ThreadSidebarOpenResult | WorkbenchThreadSidebarSnapshot) {
    if ("sidebar" in result) {
      if (result.pinnedThreadLayout.revision > this.pinnedThreadLayout.revision) this.pinnedThreadLayout = result.pinnedThreadLayout;
      for (const summary of result.projectThreads.projects) this.setProjectThreadSummary(summary);
    }
    this.install("sidebar" in result ? result.sidebar : result);
  }
  private setProjectThreadSummary(summary: WorkbenchProjectThreadSummary) {
    const existingIndex = this.projectThreadSummaries.projects.findIndex(({ projectId }) => projectId === summary.projectId);
    const existing = this.projectThreadSummaries.projects[existingIndex];
    if (existing && existing.revision > summary.revision) return false;
    if (existing && areProjectThreadSummariesEqual(existing, summary)) return false;
    const projects = [...this.projectThreadSummaries.projects];
    if (existingIndex === -1) projects.push(summary);
    else projects[existingIndex] = summary;
    this.projectThreadSummaries = { projects };
    return true;
  }
  private syncSelectedProjectThreadSummary() {
    if (!this.snapshot) return;
    this.syncProjectThreadSummary(this.snapshot);
  }
  private syncProjectThreadSummary(snapshot: WorkbenchThreadSidebarSnapshot) {
    this.setProjectThreadSummary(createWorkbenchProjectThreadSummary(
      snapshot.projectId,
      snapshot.entries,
      snapshot.revision,
      snapshot.displayOrder,
    ));
  }
  private installProjectSidebar(snapshot: WorkbenchThreadSidebarSnapshot) {
    const current = this.projectThreadSidebars.projects.find(({ projectId }) => projectId === snapshot.projectId);
    if (current && current.revision >= snapshot.revision) return false;
    const resolved = { ...snapshot, ...resolveWorkbenchThreadDisplayOrder(snapshot.entries, snapshot.displayOrder) };
    this.replaceProjectSidebar(resolved);
    this.syncProjectThreadSummary(resolved);
    return true;
  }
  private replaceProjectSidebar(snapshot: WorkbenchThreadSidebarSnapshot) {
    const index = this.projectThreadSidebars.projects.findIndex(({ projectId }) => projectId === snapshot.projectId);
    const projects = [...this.projectThreadSidebars.projects];
    if (index === -1) projects.push(snapshot);
    else projects[index] = snapshot;
    this.projectThreadSidebars = { projects };
    if (this.mode === "project" && this.projectId === snapshot.projectId) this.snapshot = snapshot;
  }
  private getProjectSidebar(projectId: string) {
    return this.getProjectSnapshot(projectId);
  }
  private findDraftProjectId(draftId: string) {
    return this.projectThreadSidebars.projects.find(({ entries }) => entries.some((entry) => (
      entry.entryKind === "draft" && entry.draft.draftId === draftId
    )))?.projectId ?? null;
  }
  private queueKey(projectId: string, draftId: string) {
    return `${encodeURIComponent(projectId)}:${draftId}`;
  }
  private installOptimisticDraft(draft: WorkbenchThreadDraft, folderId: string | null) {
    const current = this.getProjectSidebar(draft.projectId);
    if (!current) return;
    const existing = current.entries.find((entry) => entry.entryKind === "draft" && entry.draft.draftId === draft.draftId);
    const currentFolder = findWorkbenchThreadFolder(current.displayOrder, `draft:${draft.draftId}`);
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
      ? moveWorkbenchThreadDisplayItem(sortThreadSidebarEntries(entries), current.displayOrder, targetFolder.section, `draft:${draft.draftId}`, targetFolder.folderId, targetFolder.threadKeys[0] ?? null) ?? current.displayOrder
      : current.displayOrder;
    const resolved = resolveWorkbenchThreadDisplayOrder(entries, displayOrder);
    this.replaceProjectSidebar({ ...current, ...resolved });
    this.publish();
  }
  private async flushQueue(id: string, queue: DraftQueue) {
    const readQueuedDraft = () => queue.draft;
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    if (queue.inFlight) await queue.inFlight;
    if (queue.retired) return;
    const draft = queue.draft; const projectId = queue.projectId;
    if (!draft) return;
    queue.draft = null;
    const folderId = queue.folderId ?? undefined;
    queue.inFlight = this.options.transport.upsertDraft(projectId, draft, folderId).then(() => {
      if (queue.folderId === folderId) queue.folderId = null;
    }).finally(() => { queue.inFlight = null; });
    try {
      await queue.inFlight;
      const current = this.getProjectSidebar(projectId);
      if (current?.error?.startsWith("Draft save failed:")) {
        this.replaceProjectSidebar({ ...current, error: null });
        this.publish();
      }
    } catch (error) {
      if (queue.retired) return;
      const queuedDraft = readQueuedDraft();
      if (!queuedDraft || queuedDraft.clientUpdatedAt < draft.clientUpdatedAt) queue.draft = draft;
      const current = this.getProjectSidebar(projectId);
      if (current) {
        const message = error instanceof Error ? error.message : "Unable to save this draft.";
        this.replaceProjectSidebar({ ...current, error: `Draft save failed: ${message}`.slice(0, 500), freshness: "partial" });
        this.publish();
      }
      const retryDraft = readQueuedDraft();
      if (retryDraft) this.edit(retryDraft);
      throw error;
    }
    if (queue.draft) await this.flushQueue(id, queue);
  }
  private publish() {
    this.options.onChange(this.snapshot);
    for (const listener of this.listeners) listener();
  }
}

function areProjectThreadSummariesEqual(left: WorkbenchProjectThreadSummary, right: WorkbenchProjectThreadSummary) {
  return areDeeplyEqual(left, right);
}
