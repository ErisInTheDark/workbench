/*
 * Exports:
 * - ProjectFactsWorkspace: the workspace observation port project facts need.
 * - ProjectFolderFacts: daemon folder catalogue load state and folders not yet registered to a project.
 * - ProjectGroupFacts: the app's project group tiers with their observation phase.
 * - default ProjectFactsStore: own the `projects` and `projectGroups` observations, keeping unchanged projects, summaries and groups identity-stable and notifying only on change.
 */
import type { WorkbenchLogicalProject, WorkbenchLogicalProjectSummary } from "workbench-shared/types";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import type {
  WorkspaceProjectGroups, WorkspaceProjects, WorkspaceSourcePhase,
} from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkspaceQuerySnapshot } from "../app/WorkbenchWorkspaceClient";
import { reuseEntries, reuseEqual, reuseKeyed } from "../structural-sharing";

type Handle<Kind extends "projects" | "projectGroups"> = { getSnapshot(): WorkspaceQuerySnapshot<Kind>; release(): void };

export interface ProjectFactsWorkspace {
  observe(query: { kind: "projects" }, listener: () => void): Handle<"projects">;
  observe(query: { kind: "projectGroups" }, listener: () => void): Handle<"projectGroups">;
}

export interface ProjectFolderFacts {
  catalogues: WorkspaceProjects["catalogues"];
  observed: WorkspaceProjects["observedProjects"];
}

export interface ProjectGroupFacts {
  phase: WorkspaceSourcePhase;
  data: WorkspaceProjectGroups | null;
}

const NO_PROJECTS: readonly WorkbenchLogicalProject[] = [];

function reconcileProjects(previous: WorkspaceProjects | undefined, raw: WorkspaceProjects | undefined) {
  if (!raw || !previous) return raw;
  const next: WorkspaceProjects = {
    projects: reuseKeyed(previous.projects, raw.projects, project => project.id),
    summaries: reuseEntries(previous.summaries, raw.summaries),
    observedProjects: reuseEqual(previous.observedProjects, raw.observedProjects),
    sources: reuseEqual(previous.sources, raw.sources),
    catalogues: reuseEqual(previous.catalogues, raw.catalogues),
    navigation: reuseEqual(previous.navigation, raw.navigation),
  };
  return (Object.keys(next) as (keyof WorkspaceProjects)[]).every(key => next[key] === previous[key]) ? previous : next;
}

export default class ProjectFactsStore {
  private readonly projects: Handle<"projects">;
  private readonly groups: Handle<"projectGroups">;
  private readonly listeners = new Set<() => void>();
  private raw: WorkspaceProjects | undefined;
  private data: WorkspaceProjects | undefined;
  private folders: ProjectFolderFacts | null = null;
  private groupFacts: ProjectGroupFacts = { phase: "pending", data: null };
  private heard: { data: WorkspaceProjects | undefined; folders: ProjectFolderFacts | null; groups: ProjectGroupFacts }
    = { data: undefined, folders: null, groups: this.groupFacts };
  private disposed = false;

  /** `onChange` hears every observation update, changed or not, after this store has reconciled it. */
  constructor(workspace: ProjectFactsWorkspace, private readonly onChange: () => void) {
    this.projects = workspace.observe({ kind: "projects" }, () => this.changed());
    this.groups = workspace.observe({ kind: "projectGroups" }, () => this.changed());
  }

  /** The reconciled `projects` observation value; undefined until it first lands. */
  getData = () => this.reconcile().data;
  getFailure = () => this.projects.getSnapshot().failure;
  getProjects = () => this.getData()?.projects ?? NO_PROJECTS;
  getProject = (id: string) => this.getProjects().find(project => project.id === id) ?? null;
  getForLocation = (location: ProjectLocationReference) => this.getProjects().find(project =>
    project.locations.some(item => item.daemonId === location.daemonId
      && item.target.projectId === location.projectId)
    || project.observedLocations?.some(item => item.daemonId === location.daemonId
      && item.projectId === location.projectId)) ?? null;
  getSummary = (id: string): WorkbenchLogicalProjectSummary | null => this.getData()?.summaries[id] ?? null;
  getFolders = () => this.reconcile().folders;
  getGroups = () => this.reconcile().groupFacts;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.projects.release();
    this.groups.release();
  }

  /** Compares with what listeners last heard, since a read elsewhere may already have reconciled this update. */
  private changed() {
    if (this.disposed) return;
    this.reconcile();
    const heard = this.heard;
    const changed = heard.data !== this.data || heard.folders !== this.folders || heard.groups !== this.groupFacts;
    this.heard = { data: this.data, folders: this.folders, groups: this.groupFacts };
    this.onChange();
    if (changed) for (const listener of this.listeners) listener();
  }

  /** Reads reconcile lazily too, so a read between an update and its notification sees the same value. */
  private reconcile() {
    const raw = this.projects.getSnapshot().value?.data;
    if (raw !== this.raw) {
      this.raw = raw;
      this.data = reconcileProjects(this.data, raw);
      const folders = this.data ? { catalogues: this.data.catalogues, observed: this.data.observedProjects } : null;
      this.folders = folders && this.folders && folders.catalogues === this.folders.catalogues
        && folders.observed === this.folders.observed ? this.folders : folders;
    }
    const groups = this.groups.getSnapshot();
    this.groupFacts = reuseEqual(this.groupFacts, { phase: groups.phase, data: groups.value?.data ?? null });
    return this;
  }
}
