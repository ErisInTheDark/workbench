/*
 * Exports:
 * - ThreadSidebarClientOptions: app-owned draft mutation ports and view publication.
 * - default ThreadSidebarClient: source-qualified sidebar facts, the combined thread listing and its activity-free structure, selected-folder view and app draft actions.
 */
import type {
  WorkbenchLogicalThreadRow, WorkbenchThreadListing, WorkbenchThreadListingStructure, WorkbenchThreadSidebarStore,
} from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { reuseEntries, reuseEqual, reuseKeyed } from "../structural-sharing";
import type { DraftId, ProjectId } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkspaceThreadRows } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkbenchProjectedThreadRow } from "workbench-shared/workbench/project/workbench-project-projection";
import type {
  WorkbenchHomeThreadDisplayOrderSnapshot, WorkbenchPinnedThreadLayoutSnapshot,
  WorkbenchProjectThreadSummaries, WorkbenchThreadDraft,
} from "workbench-shared/workbench/thread/thread-state";
import type {
  WorkbenchProjectThreadRowSidebars as WorkbenchProjectThreadSidebars,
  WorkbenchThreadSidebarRowSnapshot as WorkbenchThreadSidebarSnapshot,
} from "workbench-shared/workbench/thread/thread-sidebar-row";

export interface ThreadSidebarClientOptions {
  onChange(snapshot: WorkbenchThreadSidebarSnapshot | null): void;
  remove(projectId: ProjectId, draftId: DraftId): Promise<void>;
  move(source: ProjectId, destination: ProjectId, draftId: DraftId): Promise<void>;
}

const EMPTY_LISTING: WorkbenchThreadListing = {
  members: {}, rows: [], archivedCount: 0, status: { listed: false, loading: false, error: "" },
};

function rowKey(row: WorkbenchLogicalThreadRow) {
  const id = row.entry.entryKind === "draft" ? `draft:${row.entry.draft.draftId}` : `thread:${row.entry.identity.threadId}`;
  return `${row.logicalProjectId}\0${row.location.daemonId}/${row.location.projectId}\0${id}`;
}

export default class ThreadSidebarClient implements WorkbenchThreadSidebarStore {
  private selected: ProjectLocationReference | null = null;
  private view: WorkbenchThreadSidebarSnapshot | null = null;
  private sidebars: WorkbenchProjectThreadSidebars = { projects: [] };
  private sourceSidebars = new Map<string, WorkbenchThreadSidebarSnapshot>();
  private summaries: WorkbenchProjectThreadSummaries = { projects: [] };
  private readonly listeners = new Set<() => void>();
  private listing: WorkbenchThreadListing = EMPTY_LISTING;
  private structure: WorkbenchThreadListingStructure = { slots: {} };
  private readonly listingListeners = new Set<() => void>();
  private disposed = false;
  private readonly home: WorkbenchHomeThreadDisplayOrderSnapshot = {
    displayOrder: {}, revision: 0, updateKind: "homeThreadDisplayOrder",
  };
  private readonly pinned: WorkbenchPinnedThreadLayoutSnapshot = {
    displayOrder: {}, revision: 0, updateKind: "pinnedThreadLayout",
  };

  constructor(private readonly options: ThreadSidebarClientOptions) {}

  private sourceKey(location: ProjectLocationReference) {
    return `${location.daemonId}/${location.projectId}`;
  }

  getSnapshot = () => this.view;
  getProjectSnapshot = (id: ProjectId) => this.sidebars.projects.find(item => item.projectId === id) ?? null;
  getLocationSnapshot = (location: ProjectLocationReference) => this.sourceSidebars.get(this.sourceKey(location)) ?? null;
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
  getListing = () => this.listing;
  getListingStructure = () => this.structure;
  subscribeListing = (listener: () => void) => {
    this.listingListeners.add(listener);
    return () => { this.listingListeners.delete(listener); };
  };

  /** Unchanged members, rows, placement and folders keep their identity; listeners hear only real changes. */
  acceptListing(next: WorkbenchThreadListing) {
    if (this.disposed) return;
    const previous = this.listing;
    const members = reuseEntries(previous.members, next.members);
    const rows = reuseKeyed(previous.rows, next.rows, rowKey);
    const placement = reuseEqual(previous.placement, next.placement);
    const folders = reuseEqual(previous.folders, next.folders);
    const status = reuseEqual(previous.status, next.status);
    if (members === previous.members && rows === previous.rows && placement === previous.placement
      && folders === previous.folders && status === previous.status && next.archivedCount === previous.archivedCount) return;
    this.listing = {
      members, rows, status, archivedCount: next.archivedCount,
      ...(placement ? { placement } : {}), ...(folders ? { folders } : {}),
    };
    const slots = reuseEntries(this.structure.slots, Object.fromEntries(Object.entries(members)
      .map(([key, { title: _title, activityAt: _activityAt, ...slot }]) => [key, slot])));
    if (slots !== this.structure.slots || placement !== this.structure.placement) {
      this.structure = { slots, ...(placement ? { placement } : {}) };
    }
    for (const listener of this.listingListeners) listener();
  }

  /** Rows are the listed rows whose detail is known; `projects` carries each listed location's load state. */
  acceptFacts(selected: ProjectLocationReference | null, rows: readonly WorkbenchProjectedThreadRow[],
    projects: WorkspaceThreadRows["projects"], summaries: WorkbenchProjectThreadSummaries = { projects: [] }) {
    const sources = new Map<string, WorkbenchThreadSidebarSnapshot>();
    const entriesBySource = new Map<string, WorkbenchThreadSidebarSnapshot["entries"]>();
    for (const row of rows) {
      const key = this.sourceKey(row.location);
      const entries = entriesBySource.get(key) ?? [];
      entries.push(row.entry);
      entriesBySource.set(key, entries);
    }
    for (const source of projects) {
      const key = this.sourceKey(source.location);
      const previous = this.sourceSidebars.get(key);
      const candidate: WorkbenchThreadSidebarSnapshot = {
        projectId: source.location.projectId,
        revision: previous?.revision ?? 0,
        entries: entriesBySource.get(key) ?? [],
        freshness: source.phase === "current" ? "fresh" : "partial",
        error: source.failure,
        archivedCount: source.archivedCount ?? 0,
      };
      sources.set(key, previous && areDeeplyEqual(previous, candidate)
        ? previous : { ...candidate, revision: (previous?.revision ?? 0) + 1 });
    }
    const sidebar = selected ? sources.get(this.sourceKey(selected)) ?? null : null;
    const nextSidebars = { projects: sidebar ? [sidebar] : [] };
    const sidebars = areDeeplyEqual(this.sidebars, nextSidebars) ? this.sidebars : nextSidebars;
    const changed = !areDeeplyEqual(this.selected, selected)
      || !areDeeplyEqual(this.sidebars, sidebars)
      || !areDeeplyEqual(this.summaries, summaries)
      || sources.size !== this.sourceSidebars.size
      || [...sources].some(([key, value]) => this.sourceSidebars.get(key) !== value);
    if (!changed) return;
    this.selected = selected;
    this.sourceSidebars = sources;
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
    this.listingListeners.clear();
    return Promise.resolve();
  }

  private publish() {
    if (this.disposed) return;
    const base = this.selected ? this.getProjectSnapshot(this.selected.projectId) : null;
    const next = base;
    if (!areDeeplyEqual(this.view, next)) {
      this.view = next;
      this.options.onChange(next);
    }
    for (const listener of this.listeners) listener();
  }
}
