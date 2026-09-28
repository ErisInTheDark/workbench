/*
 * Exports:
 * - ThreadSidebarClientOptions: app-owned draft mutation ports and view publication.
 * - default ThreadSidebarClient: selected-folder sidebar facts and app draft actions.
 */
import type { WorkbenchThreadSidebarStore } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { DraftId, ProjectId } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type {
  WorkbenchHomeThreadDisplayOrderSnapshot, WorkbenchPinnedThreadLayoutSnapshot,
  WorkbenchProjectThreadSidebars, WorkbenchProjectThreadSummaries,
  WorkbenchThreadDraft, WorkbenchThreadSidebarSnapshot,
} from "workbench-shared/workbench/thread/thread-state";

export interface ThreadSidebarClientOptions {
  onChange(snapshot: WorkbenchThreadSidebarSnapshot | null): void;
  remove(projectId: ProjectId, draftId: DraftId): Promise<void>;
  move(source: ProjectId, destination: ProjectId, draftId: DraftId): Promise<void>;
}

export default class ThreadSidebarClient implements WorkbenchThreadSidebarStore {
  private selected: ProjectLocationReference | null = null;
  private view: WorkbenchThreadSidebarSnapshot | null = null;
  private sidebars: WorkbenchProjectThreadSidebars = { projects: [] };
  private summaries: WorkbenchProjectThreadSummaries = { projects: [] };
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  private readonly home: WorkbenchHomeThreadDisplayOrderSnapshot = {
    displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder",
  };
  private readonly pinned: WorkbenchPinnedThreadLayoutSnapshot = {
    displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout",
  };

  constructor(private readonly options: ThreadSidebarClientOptions) {}

  getSnapshot = () => this.view;
  getProjectSnapshot = (id: ProjectId) => this.sidebars.projects.find(item => item.projectId === id) ?? null;
  getProjectThreadSidebars = () => this.sidebars;
  getProjectThreadSummaries = () => this.summaries;
  getHomeThreadDisplayOrder = () => this.home;
  getHomeThreadDisplayOrderSupported = () => false;
  getPinnedThreadLayout = () => this.pinned;
  getDraft = (projectId: ProjectId, draftId: DraftId): WorkbenchThreadDraft | null => {
    const entry = this.getProjectSnapshot(projectId)?.entries.find(item =>
      item.entryKind === "draft" && item.draft.draftId === draftId);
    return entry?.entryKind === "draft" ? entry.draft : null;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  // The caller supplies one source-qualified folder, never a merge by physical project ID.
  acceptFacts(selected: ProjectLocationReference | null, sidebar: WorkbenchThreadSidebarSnapshot | null,
    summaries: WorkbenchProjectThreadSummaries = { projects: [] }) {
    const sidebars = { projects: sidebar ? [sidebar] : [] };
    if (areDeeplyEqual(this.selected, selected) && areDeeplyEqual(this.sidebars, sidebars)
      && areDeeplyEqual(this.summaries, summaries)) return;
    this.selected = selected;
    this.sidebars = sidebars;
    this.summaries = summaries;
    this.publish();
  }

  async delete(draftId: DraftId, _clientUpdatedAt?: number, projectId = this.selected?.projectId) {
    if (!projectId) throw new Error("The draft owner is unavailable.");
    await this.options.remove(projectId, draftId);
  }

  async moveDraft(source: ProjectId, destination: ProjectId, draftId: DraftId) {
    await this.options.move(source, destination, draftId);
  }

  dispose() {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.listeners.clear();
    return Promise.resolve();
  }

  private publish() {
    if (this.disposed) return;
    const base = this.selected ? this.getProjectSnapshot(this.selected.projectId) : null;
    const next = base;
    if (!areDeeplyEqual(this.view, next)) this.view = next;
    this.options.onChange(this.getSnapshot());
    for (const listener of this.listeners) listener();
  }
}
