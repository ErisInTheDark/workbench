/*
 * Exports:
 * - ThreadSidebarClientOptions: app-owned draft mutation ports and view publication.
 * - default ThreadSidebarClient: source-qualified sidebar facts, selected-folder view and app draft actions.
 */
import type { WorkbenchThreadSidebarStore } from "workbench-shared/types";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import type { DraftId, ProjectId } from "workbench-shared/workbench/identity";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type { WorkspaceThreadRows } from "workbench-shared/workbench/workspace/workspace-observation";
import type {
  WorkbenchHomeThreadDisplayOrderSnapshot, WorkbenchPinnedThreadLayoutSnapshot,
  WorkbenchProjectThreadSummaries, WorkbenchThreadDraft,
} from "workbench-shared/workbench/thread/thread-state";
import {
  projectSidebarRow,
  type WorkbenchProjectThreadRowSidebars as WorkbenchProjectThreadSidebars,
  type WorkbenchThreadSidebarRowSnapshot as WorkbenchThreadSidebarSnapshot,
} from "workbench-shared/workbench/thread/thread-sidebar-row";

export interface ThreadSidebarClientOptions {
  onChange(snapshot: WorkbenchThreadSidebarSnapshot | null): void;
  remove(projectId: ProjectId, draftId: DraftId): Promise<void>;
  move(source: ProjectId, destination: ProjectId, draftId: DraftId): Promise<void>;
}

export default class ThreadSidebarClient implements WorkbenchThreadSidebarStore {
  private selected: ProjectLocationReference | null = null;
  private view: WorkbenchThreadSidebarSnapshot | null = null;
  private sidebars: WorkbenchProjectThreadSidebars = { projects: [] };
  private sourceSidebars = new Map<string, WorkbenchThreadSidebarSnapshot>();
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

  acceptFacts(selected: ProjectLocationReference | null, rows: WorkspaceThreadRows | null,
    summaries: WorkbenchProjectThreadSummaries = { projects: [] }) {
    const sources = new Map<string, WorkbenchThreadSidebarSnapshot>();
    const entriesBySource = new Map<string, WorkbenchThreadSidebarSnapshot["entries"]>();
    for (const row of rows?.rows ?? []) {
      const key = this.sourceKey(row.location);
      const entries = entriesBySource.get(key) ?? [];
      // Protocol 1 apps still send full entries; the store holds only lean rows.
      entries.push(projectSidebarRow(row.entry));
      entriesBySource.set(key, entries);
    }
    for (const source of rows?.projects ?? []) {
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
