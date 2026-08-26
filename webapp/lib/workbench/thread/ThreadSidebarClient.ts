/*
 * Exports:
 * - ThreadSidebarTransport/ThreadSidebarClientOptions/ThreadSidebarAcceptedIntent: pushed snapshot, mutation ports, and provider-confirmed local admission. Keywords: browser, websocket, drafts, intent.
 * - default ThreadSidebarClient: subscribable browser observation, cross-project summary projection, revision, optimistic draft, and leave-safe queue owner. Keywords: sidebar, project, status, external store, debounce, flush.
 */
import type { WorkbenchThreadSidebarStore } from "../../types";
import { areDeeplyEqual } from "../deep-equality";
import { findWorkbenchThreadFolder, moveWorkbenchThreadDisplayItem, replaceWorkbenchThreadFolderMember, resolveWorkbenchThreadDisplayOrder, sortThreadSidebarEntries } from "./thread-display-order";
import { createDraftTitle, createWorkbenchProjectThreadSummary, type WorkbenchHarnessId, type WorkbenchProjectThreadSummaries, type WorkbenchProjectThreadSummary, type WorkbenchProjectThreadSummaryUpdate, type WorkbenchThreadActivityUpdate, type WorkbenchThreadDraft, type WorkbenchThreadSidebarSnapshot } from "./thread-state";

export interface ThreadSidebarOpenResult {
  projectThreads: WorkbenchProjectThreadSummaries;
  sidebar: WorkbenchThreadSidebarSnapshot;
}

export interface ThreadSidebarTransport {
  close(projectId: string): Promise<void>;
  deleteDraft(projectId: string, draftId: string, clientUpdatedAt: number): Promise<void>;
  open(projectId: string): Promise<ThreadSidebarOpenResult | WorkbenchThreadSidebarSnapshot>;
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
  title: string;
  turnId: string;
}

interface DraftQueue {
  draft: WorkbenchThreadDraft | null;
  folderId: string | null;
  inFlight: Promise<void> | null;
  retired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export default class ThreadSidebarClient implements WorkbenchThreadSidebarStore {
  private isOpen = false;
  private projectId: string | null = null;
  private projectThreadSummaries: WorkbenchProjectThreadSummaries = { projects: [] };
  private revision = -1;
  private snapshot: WorkbenchThreadSidebarSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly queues = new Map<string, DraftQueue>();
  constructor(private readonly options: ThreadSidebarClientOptions) {}

  readonly getSnapshot = () => this.snapshot;
  readonly getProjectThreadSummaries = () => this.projectThreadSummaries;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async open(projectId: string) {
    if (this.projectId === projectId && this.snapshot && this.isOpen) return true;
    if (this.projectId && this.projectId !== projectId) await this.close();
    this.projectId = projectId;
    this.isOpen = false;
    this.revision = -1;
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
  accept(snapshot: WorkbenchThreadSidebarSnapshot) { if (snapshot.projectId === this.projectId && snapshot.revision > this.revision) this.install(snapshot); }
  acceptProjectThreadSummaries(snapshot: WorkbenchProjectThreadSummaries) {
    this.projectThreadSummaries = snapshot;
    this.publish();
  }
  acceptProjectThreadSummary(update: WorkbenchProjectThreadSummaryUpdate) {
    if (this.setProjectThreadSummary(update.summary)) this.publish();
  }
  acceptActivity(update: WorkbenchThreadActivityUpdate) {
    if (update.projectId !== this.projectId || update.revision <= this.revision || !this.snapshot) return;
    const entries = this.snapshot.entries.map((entry) => entry.entryKind !== "draft" && entry.identity.harness === update.identity.harness && entry.identity.threadId === update.identity.threadId
      ? entry.entryKind === "thread" && update.orderAt !== undefined
        ? { ...entry, activityAt: update.activityAt, orderAt: update.orderAt }
        : { ...entry, activityAt: update.activityAt }
      : entry);
    this.revision = update.revision;
    const resolved = resolveWorkbenchThreadDisplayOrder(entries, update.displayOrder ?? this.snapshot.displayOrder);
    this.snapshot = { ...this.snapshot, ...resolved, revision: update.revision };
    this.publish();
  }
  edit(draft: WorkbenchThreadDraft, options: { folderId?: string } = {}) {
    if (draft.projectId !== this.projectId) throw new Error("The draft does not belong to the observed project.");
    const queue = this.queues.get(draft.draftId) ?? { draft: null, folderId: null, inFlight: null, retired: false, timer: null };
    if (queue.retired) return;
    if (options.folderId) queue.folderId = options.folderId;
    queue.draft = draft;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => {
      queue.timer = null;
      void this.flushQueue(draft.draftId, queue).catch(() => undefined);
    }, 500);
    this.queues.set(draft.draftId, queue);
    this.installOptimisticDraft(draft, queue.folderId);
  }
  acceptIntent(intent: ThreadSidebarAcceptedIntent) {
    const queue = intent.draftId ? this.queues.get(intent.draftId) : null;
    if (queue?.timer) clearTimeout(queue.timer);
    if (queue) {
      queue.draft = null;
      queue.retired = true;
      queue.timer = null;
    }
    const inFlight = queue?.inFlight?.catch(() => undefined) ?? Promise.resolve();
    if (intent.draftId && queue) {
      void inFlight.finally(() => {
        if (this.queues.get(intent.draftId!) === queue) this.queues.delete(intent.draftId!);
      });
    }
    if (this.snapshot) {
      const activityAt = intent.activityAt ?? Date.now();
      const existing = this.snapshot.entries.find((entry) => entry.entryKind === "thread"
        && entry.identity.harness === intent.identity.harness
        && entry.identity.threadId === intent.identity.threadId);
      const sourceDraft = intent.draftId
        ? this.snapshot.entries.find((entry) => entry.entryKind === "draft" && entry.draft.draftId === intent.draftId)
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
        ? replaceWorkbenchThreadFolderMember(this.snapshot.displayOrder, `draft:${intent.draftId}`, `${intent.identity.harness}:${intent.identity.threadId}`)
        : this.snapshot.displayOrder;
      const resolved = resolveWorkbenchThreadDisplayOrder([
          ...this.snapshot.entries.filter((candidate) => {
            if (candidate.entryKind === "draft") return candidate.draft.draftId !== intent.draftId;
            if (candidate.entryKind === "subagent") return true;
            return candidate.identity.harness !== intent.identity.harness || candidate.identity.threadId !== intent.identity.threadId;
          }),
          entry,
        ], displayOrder);
      this.snapshot = { ...this.snapshot, ...resolved };
      this.syncSelectedProjectThreadSummary();
      this.publish();
    }
    return inFlight;
  }
  async delete(draftId: string, clientUpdatedAt = Date.now()) {
    const queue = this.queues.get(draftId);
    if (queue?.timer) clearTimeout(queue.timer);
    if (queue) { queue.timer = null; queue.draft = null; await queue.inFlight; }
    if (!this.projectId) return;
    await this.options.transport.deleteDraft(this.projectId, draftId, clientUpdatedAt);
    this.queues.delete(draftId);
    if (this.snapshot) {
      const resolved = resolveWorkbenchThreadDisplayOrder(
        this.snapshot.entries.filter((entry) => entry.entryKind !== "draft" || entry.draft.draftId !== draftId),
        this.snapshot.displayOrder,
      );
      this.snapshot = { ...this.snapshot, ...resolved };
      this.publish();
    }
  }
  async flush() { for (const [id, queue] of this.queues) await this.flushQueue(id, queue); }
  async guardNavigation(action: () => void | Promise<void>) { await this.flush(); await action(); }
  bestEffortFlush() { void this.flush().catch(() => undefined); }
  async reopen() {
    if (!this.projectId) return;
    this.revision = -1;
    this.installOpenResult(await this.options.transport.open(this.projectId));
  }
  async close() { if (!this.projectId) return; await this.flush(); const projectId = this.projectId; this.projectId = null; this.isOpen = false; this.snapshot = null; this.publish(); await this.options.transport.close(projectId).catch((error: unknown) => { console.warn("Unable to close the thread sidebar observation.", error); }); }
  private install(snapshot: WorkbenchThreadSidebarSnapshot) {
    if (snapshot.revision <= this.revision) return;
    this.revision = snapshot.revision;
    this.snapshot = { ...snapshot, ...resolveWorkbenchThreadDisplayOrder(snapshot.entries, snapshot.displayOrder) };
    this.syncSelectedProjectThreadSummary();
    this.publish();
  }
  private installOpenResult(result: ThreadSidebarOpenResult | WorkbenchThreadSidebarSnapshot) {
    if ("sidebar" in result) this.projectThreadSummaries = result.projectThreads;
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
    this.setProjectThreadSummary(createWorkbenchProjectThreadSummary(
      this.snapshot.projectId,
      this.snapshot.entries,
      this.snapshot.revision,
    ));
  }
  private installOptimisticDraft(draft: WorkbenchThreadDraft, folderId: string | null) {
    if (!this.snapshot) return;
    const existing = this.snapshot.entries.find((entry) => entry.entryKind === "draft" && entry.draft.draftId === draft.draftId);
    const currentFolder = findWorkbenchThreadFolder(this.snapshot.displayOrder, `draft:${draft.draftId}`);
    const targetFolder = folderId ? this.snapshot.displayOrder?.folders?.find((candidate) => candidate.folderId === folderId) : null;
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
        ...this.snapshot.entries.filter((candidate) => candidate.entryKind !== "draft" || candidate.draft.draftId !== draft.draftId),
        entry,
      ];
    const displayOrder = targetFolder && currentFolder?.folderId !== targetFolder.folderId
      ? moveWorkbenchThreadDisplayItem(sortThreadSidebarEntries(entries), this.snapshot.displayOrder, targetFolder.section, `draft:${draft.draftId}`, targetFolder.folderId, targetFolder.threadKeys[0] ?? null) ?? this.snapshot.displayOrder
      : this.snapshot.displayOrder;
    const resolved = resolveWorkbenchThreadDisplayOrder(entries, displayOrder);
    this.snapshot = { ...this.snapshot, ...resolved };
    this.publish();
  }
  private async flushQueue(id: string, queue: DraftQueue) {
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    if (queue.inFlight) await queue.inFlight;
    if (queue.retired) return;
    const draft = queue.draft; const projectId = this.projectId;
    if (!draft || !projectId) return;
    queue.draft = null;
    const folderId = queue.folderId ?? undefined;
    queue.inFlight = this.options.transport.upsertDraft(projectId, draft, folderId).then(() => {
      if (queue.folderId === folderId) queue.folderId = null;
    }).finally(() => { queue.inFlight = null; });
    try {
      await queue.inFlight;
      if (this.snapshot?.error?.startsWith("Draft save failed:")) {
        this.snapshot = { ...this.snapshot, error: null };
        this.publish();
      }
    } catch (error) {
      if (queue.retired) return;
      if (!queue.draft || queue.draft.clientUpdatedAt < draft.clientUpdatedAt) queue.draft = draft;
      if (this.snapshot) {
        const message = error instanceof Error ? error.message : "Unable to save this draft.";
        this.snapshot = { ...this.snapshot, error: `Draft save failed: ${message}`.slice(0, 500), freshness: "partial" };
        this.publish();
      }
      this.edit(queue.draft);
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
