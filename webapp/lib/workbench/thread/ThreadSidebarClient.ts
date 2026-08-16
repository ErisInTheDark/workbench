/*
 * Exports:
 * - ThreadSidebarTransport/ThreadSidebarClientOptions: pushed snapshot and mutation ports. Keywords: browser, websocket, drafts.
 * - default ThreadSidebarClient: browser observation, revision, optimistic draft, and leave-safe queue owner. Keywords: sidebar, debounce, flush.
 */
import type { WorkbenchThreadDraftSaveState } from "../../types";
import { createDraftTitle, sortThreadSidebarEntries, type WorkbenchThreadDraft, type WorkbenchThreadStateSnapshot } from "./thread-state";

export interface ThreadSidebarTransport {
  close(projectId: string): Promise<void>;
  deleteDraft(projectId: string, draftId: string, clientUpdatedAt: number): Promise<void>;
  open(projectId: string): Promise<WorkbenchThreadStateSnapshot>;
  upsertDraft(projectId: string, draft: WorkbenchThreadDraft): Promise<void>;
}
export interface ThreadSidebarClientOptions {
  onChange: (snapshot: WorkbenchThreadStateSnapshot | null) => void;
  onDraftSaveStateChange?: (draftId: string, state: WorkbenchThreadDraftSaveState) => void;
  transport: ThreadSidebarTransport;
}

interface DraftQueue {
  draft: WorkbenchThreadDraft | null;
  inFlight: Promise<void> | null;
  lastAcceptedClientUpdatedAt: number;
  state: WorkbenchThreadDraftSaveState;
  timer: ReturnType<typeof setTimeout> | null;
}

export default class ThreadSidebarClient {
  private projectId: string | null = null;
  private revision = -1;
  private snapshot: WorkbenchThreadStateSnapshot | null = null;
  private readonly queues = new Map<string, DraftQueue>();
  constructor(private readonly options: ThreadSidebarClientOptions) {}

  async open(projectId: string) {
    if (this.projectId === projectId && this.snapshot) return;
    if (this.projectId && this.projectId !== projectId) await this.close();
    this.projectId = projectId;
    this.revision = -1;
    try {
      this.install(await this.options.transport.open(projectId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open the thread sidebar.";
      this.install({ entries: [], error: message.slice(0, 500), freshness: "partial", projectId, revision: 0 });
    }
  }
  accept(snapshot: WorkbenchThreadStateSnapshot) { if (snapshot.projectId === this.projectId && snapshot.revision > this.revision) this.install(snapshot); }
  edit(draft: WorkbenchThreadDraft) {
    if (draft.projectId !== this.projectId) throw new Error("The draft does not belong to the observed project.");
    const queue = this.queues.get(draft.draftId) ?? { draft: null, inFlight: null, lastAcceptedClientUpdatedAt: -1, state: "saved" as const, timer: null };
    queue.draft = draft;
    this.setSaveState(draft.draftId, queue, "saving");
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => {
      queue.timer = null;
      void this.flushQueue(draft.draftId, queue).catch(() => undefined);
    }, 500);
    this.queues.set(draft.draftId, queue);
    this.installOptimisticDraft(draft);
  }
  async delete(draftId: string, clientUpdatedAt = Date.now()) {
    const queue = this.queues.get(draftId);
    if (queue?.timer) clearTimeout(queue.timer);
    if (queue) { queue.timer = null; queue.draft = null; await queue.inFlight; }
    if (!this.projectId) return;
    await this.options.transport.deleteDraft(this.projectId, draftId, clientUpdatedAt);
    this.queues.delete(draftId);
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, entries: this.snapshot.entries.filter((entry) => entry.entryKind !== "draft" || entry.draft.draftId !== draftId) };
      this.options.onChange(this.snapshot);
    }
  }
  async flush() { for (const [id, queue] of this.queues) await this.flushQueue(id, queue); }
  async guardNavigation(action: () => void | Promise<void>) { await this.flush(); await action(); }
  bestEffortFlush() { void this.flush().catch(() => undefined); }
  getDraftSaveState(draftId: string): WorkbenchThreadDraftSaveState { return this.queues.get(draftId)?.state ?? "saved"; }
  async close() { if (!this.projectId) return; await this.flush(); const projectId = this.projectId; this.projectId = null; this.snapshot = null; this.options.onChange(null); await this.options.transport.close(projectId).catch((error: unknown) => { console.warn("Unable to close the thread sidebar observation.", error); }); }
  private install(snapshot: WorkbenchThreadStateSnapshot) { if (snapshot.revision <= this.revision) return; this.revision = snapshot.revision; this.snapshot = snapshot; this.options.onChange(snapshot); }
  private installOptimisticDraft(draft: WorkbenchThreadDraft) {
    if (!this.snapshot) return;
    const entry = {
      activityAt: draft.updatedAt,
      draft,
      entryKind: "draft" as const,
      metadata: { archived: false as const, pinned: false, snoozed: false },
      title: createDraftTitle(draft.prompt),
    };
    this.snapshot = {
      ...this.snapshot,
      entries: sortThreadSidebarEntries([
        ...this.snapshot.entries.filter((candidate) => candidate.entryKind !== "draft" || candidate.draft.draftId !== draft.draftId),
        entry,
      ]),
    };
    this.options.onChange(this.snapshot);
  }
  private setSaveState(draftId: string, queue: DraftQueue, state: WorkbenchThreadDraftSaveState) {
    if (queue.state === state) return;
    queue.state = state;
    this.options.onDraftSaveStateChange?.(draftId, state);
  }
  private async flushQueue(id: string, queue: DraftQueue) {
    if (queue.timer) { clearTimeout(queue.timer); queue.timer = null; }
    if (queue.inFlight) await queue.inFlight;
    const draft = queue.draft; const projectId = this.projectId;
    if (!draft || !projectId) return;
    queue.draft = null;
    queue.inFlight = this.options.transport.upsertDraft(projectId, draft).finally(() => { queue.inFlight = null; });
    try {
      await queue.inFlight;
      queue.lastAcceptedClientUpdatedAt = Math.max(queue.lastAcceptedClientUpdatedAt, draft.clientUpdatedAt);
      if (!queue.draft) this.setSaveState(id, queue, "saved");
      if (this.snapshot?.error?.startsWith("Draft save failed:")) {
        this.snapshot = { ...this.snapshot, error: null };
        this.options.onChange(this.snapshot);
      }
    } catch (error) {
      if (!queue.draft || queue.draft.clientUpdatedAt < draft.clientUpdatedAt) queue.draft = draft;
      this.setSaveState(id, queue, "failed");
      if (this.snapshot) {
        const message = error instanceof Error ? error.message : "Unable to save this draft.";
        this.snapshot = { ...this.snapshot, error: `Draft save failed: ${message}`.slice(0, 500), freshness: "partial" };
        this.options.onChange(this.snapshot);
      }
      this.edit(queue.draft);
      throw error;
    }
    if (queue.draft) await this.flushQueue(id, queue);
  }
}
