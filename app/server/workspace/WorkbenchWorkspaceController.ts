/*
 * Exports:
 * - default WorkbenchWorkspaceController: own shared catalogue, placement demand, registration and cross-daemon project projections.
 */
import type { DaemonId, ProjectId } from "workbench-shared/workbench/identity";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import type { WorkbenchProjectLocationsPayload } from "workbench-shared/workbench/project/project-location";
import type { WorkbenchProjectThreadSummaries } from "workbench-shared/workbench/thread/thread-state";
import type { WorkspaceProjectGroups, WorkspaceProjects, WorkspaceSourcePhase } from "workbench-shared/workbench/workspace/workspace-observation";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { projectLogicalGroups, projectLogicalProjects, projectLogicalSummaries } from "workbench-shared/workbench/project/workbench-project-projection";
import { hasUnarchivedSidebarWork } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController";
import type WorkbenchDaemonSource from "./WorkbenchDaemonSource";
import type WorkbenchDaemonSources from "./WorkbenchDaemonSources";
import type { WorkbenchProjectAlias } from "workbench-shared/types";
import WorkbenchWorkspaceSearch from "./WorkbenchWorkspaceSearch";

type Observation = ReturnType<WorkbenchDaemonSource["observe"]>;
interface SourceInterest {
  catalogue: Observation;
  summaries: Observation | null;
  placement: Observation | null;
  placementFallback: { projectIds: readonly ProjectId[]; observation: Observation } | null;
  registered: WorkbenchProjectLocationsPayload | null;
  registrationAttempt: string | null;
  registrationFailure: string | null;
}

export default class WorkbenchWorkspaceController {
  readonly search: WorkbenchWorkspaceSearch;
  private readonly interests = new Map<DaemonId, SourceInterest>();
  private readonly listeners = new Set<() => void>();
  private readonly demands = new Map<object, { summaries: boolean; placement?: boolean; daemonIds?: readonly DaemonId[] }>();
  private readonly unsubscribe: Array<() => void> = [];
  private updating = false;
  private updateRequested = false;
  private snapshot: WorkspaceProjects = { projects: [], observedProjects: [], summaries: {}, sources: [], catalogues: [], navigation: [] };
  private groups: { data: WorkspaceProjectGroups; phase: WorkspaceSourcePhase; failure: string | null } = {
    data: { orderedProjectIds: [], unsettledProjectIds: [], unarchivedProjectIds: [] },
    phase: "pending", failure: null,
  };
  private bindings: Array<{ daemonId: DaemonId; attachedLocal: boolean; aliases: readonly WorkbenchProjectAlias[] }> = [];

  constructor(private readonly options: {
    sources: WorkbenchDaemonSources;
    presentation: WorkbenchPresentationController;
    warn(message: string): void;
    canProject?(): boolean;
  }) {
    this.search = new WorkbenchWorkspaceSearch(options);
  }

  start() {
    if (this.unsubscribe.length) return;
    this.demands.set(this, { summaries: false });
    this.unsubscribe.push(
      this.options.sources.subscribe(() => this.refresh()),
      this.options.presentation.subscribe(() => this.refresh()),
    );
    this.refresh();
  }

  getSnapshot = () => this.snapshot;
  getBindings = () => this.bindings;
  getProjectGroups = () => this.groups;
  resumeProjection() {
    this.search.resumeProjection();
    this.refresh();
  }

  select(daemonIds: readonly DaemonId[]): WorkspaceProjects {
    const all = this.snapshot;
    const projects = all.projects.map(project => ({
      ...project, locations: project.locations.filter(location => daemonIds.includes(location.daemonId)),
      observedLocations: project.observedLocations?.filter(location => daemonIds.includes(location.daemonId)),
    })).filter(project => project.locations.length || project.observedLocations?.length);
    const summaries = new Map<DaemonId, WorkbenchProjectThreadSummaries>();
    for (const id of daemonIds) {
      const value = this.interests.get(id)?.summaries?.getSnapshot().value;
      if (value?.kind === "summaries") summaries.set(id, { projects: value.projects });
    }
    return { projects, summaries: Object.fromEntries(projectLogicalSummaries(projects, summaries, this.options.presentation.read())),
      observedProjects: all.observedProjects.map(project => ({
        ...project, locations: project.locations.filter(location => daemonIds.includes(location.location.daemonId)),
      })).filter(project => project.locations.length),
      sources: all.sources.filter(source => daemonIds.includes(source.daemonId)),
      catalogues: all.catalogues.filter(source => daemonIds.includes(source.daemonId)),
      navigation: all.navigation.filter(source => daemonIds.includes(source.daemonId)) };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  retain(options: { summaries?: boolean; placement?: boolean; daemonIds?: readonly DaemonId[] } = {}) {
    const token = {};
    this.demands.set(token, { ...options, summaries: options.summaries === true });
    this.refresh();
    return () => {
      if (!this.demands.delete(token)) return;
      this.refresh();
    };
  }

  dispose() {
    this.search.dispose();
    for (const stop of this.unsubscribe.splice(0)) stop();
    for (const interest of this.interests.values()) {
      interest.catalogue.release();
      interest.summaries?.release();
      interest.placement?.release();
      interest.placementFallback?.observation.release();
    }
    this.interests.clear();
    this.demands.clear();
    this.listeners.clear();
  }

  private refresh() {
    if (this.options.canProject?.() === false) return;
    if (this.updating) { this.updateRequested = true; return; }
    this.updating = true;
    try {
      do {
        this.updateRequested = false;
        this.reconcileDemand();
        this.project();
      } while (this.updateRequested);
    } finally { this.updating = false; }
  }

  private reconcileDemand() {
    const needed = new Set<DaemonId>();
    for (const source of this.options.sources.all()) {
      const demands = [...this.demands.values()].filter(demand =>
        !demand.daemonIds || demand.daemonIds.includes(source.id));
      if (!demands.length) continue;
      needed.add(source.id);
      let interest = this.interests.get(source.id);
      if (!interest) {
        interest = {
          catalogue: source.observe({ kind: "catalogue" }, () => this.refresh()),
          summaries: null, placement: null, placementFallback: null,
          registered: null, registrationAttempt: null, registrationFailure: null,
        };
        this.interests.set(source.id, interest);
      }
      const summaries = demands.some(demand => demand.summaries);
      if (summaries && !interest.summaries) {
        interest.summaries = source.observe({ kind: "summaries" }, () => this.refresh());
      } else if (!summaries && interest.summaries) {
        const previous = interest.summaries;
        interest.summaries = null;
        previous.release();
      }
      const placement = demands.some(demand => demand.placement);
      if (placement && !interest.placement) {
        interest.placement = source.observe({ kind: "projectPlacement" }, () => this.refresh());
      } else if (!placement && interest.placement) {
        interest.placement.release();
        interest.placement = null;
      }
      const placementFact = interest.placement?.getSnapshot();
      const catalogueFact = interest.catalogue.getSnapshot().value;
      const fallbackIds = catalogueFact?.kind === "catalogue"
        ? (catalogueFact.catalogue?.data.map(project => project.id) ?? []).sort() : [];
      const needsFallback = placement && (placementFact?.phase === "failed"
        || interest.placementFallback !== null && placementFact?.phase !== "current");
      if (interest.placementFallback && (!needsFallback
        || !areDeeplyEqual(interest.placementFallback.projectIds, fallbackIds))) {
        interest.placementFallback.observation.release();
        interest.placementFallback = null;
      }
      if (needsFallback && fallbackIds.length && !interest.placementFallback) {
        interest.placementFallback = {
          projectIds: fallbackIds,
          observation: source.observe({ kind: "projectThreads", projectIds: fallbackIds }, () => this.refresh()),
        };
      }
    }
    for (const [id, interest] of this.interests) {
      if (needed.has(id)) continue;
      this.interests.delete(id);
      interest.catalogue.release();
      interest.summaries?.release();
      interest.placement?.release();
      interest.placementFallback?.observation.release();
    }
  }

  private project() {
    const catalogues = new Map<DaemonId, readonly WorkbenchProjectOption[]>();
    const locations = new Map<DaemonId, { hostname: string; data: WorkbenchProjectLocationsPayload["data"] }>();
    const summaries = new Map<DaemonId, WorkbenchProjectThreadSummaries>();
    const placement = new Map<DaemonId, ReadonlySet<ProjectId>>();
    const placementPhases: WorkspaceSourcePhase[] = [];
    const placementFailures: string[] = [];
    const summaryPhases: WorkspaceSourcePhase[] = [];
    for (const [id, interest] of this.interests) {
      const source = this.options.sources.get(id);
      if (!source) continue;
      const fact = interest.catalogue.getSnapshot();
      const value = fact.value;
      if (value?.kind !== "catalogue") {
        if (interest.placement) placementPhases.push(interest.placement.getSnapshot().phase);
        if (interest.summaries) summaryPhases.push(interest.summaries.getSnapshot().phase);
        continue;
      }
      const hostname = source.getSnapshot().hostname;
      if (value.locations) {
        locations.set(id, { hostname, data: value.locations.data });
        catalogues.set(id, value.locations.data.map(item => item.project));
        const attempt = `${value.generation}:${value.revision}`;
        if (fact.phase === "current" && !areDeeplyEqual(interest.registered, value.locations)
          && interest.registrationAttempt !== attempt) {
          interest.registrationAttempt = attempt;
          try {
            this.options.presentation.mutate({
              kind: "registerLocations", daemonId: id, hostname, catalog: value.locations,
            });
            interest.registered = value.locations;
            interest.registrationFailure = null;
          } catch (error) {
            interest.registrationFailure = error instanceof Error ? error.message.slice(0, 512) : "Project registration failed.";
            this.options.warn(`Workspace project registration failed: ${interest.registrationFailure}`);
          }
        }
      }
      const summary = interest.summaries?.getSnapshot().value;
      if (summary?.kind === "summaries") summaries.set(id, { projects: summary.projects });
      if (interest.summaries) summaryPhases.push(interest.summaries.getSnapshot().phase);
      if (interest.placement) {
        const compact = interest.placement.getSnapshot();
        const fallback = interest.placementFallback?.observation.getSnapshot();
        if (compact.value?.kind === "projectPlacement"
          && (compact.phase === "current"
            || compact.phase !== "failed" && fallback?.phase !== "current")) {
          placement.set(id, new Set(compact.value.projects
            .filter(project => project.hasUnarchivedWork).map(project => project.projectId)));
          placementPhases.push(compact.phase);
          if (compact.failure) placementFailures.push(compact.failure);
        } else if (fallback?.value?.kind === "projectThreads") {
          placement.set(id, new Set(fallback.value.projects.flatMap(project =>
            project.sidebar && hasUnarchivedSidebarWork(project.sidebar.entries) ? [project.projectId] : [])));
          placementPhases.push(fallback.phase);
          if (fallback.failure) placementFailures.push(fallback.failure);
        } else {
          placementPhases.push(compact.phase);
          if (compact.failure) placementFailures.push(compact.failure);
        }
      }
    }
    const presentation = this.options.presentation.read();
    const projects = projectLogicalProjects(presentation, catalogues, locations);
    const registeredKeys = new Set(presentation.projects.map(project => project.matchKey));
    const observed = new Map<string, WorkspaceProjects["observedProjects"][number]>();
    for (const [daemonId, source] of locations) {
      for (const row of source.data) {
        if (registeredKeys.has(row.identityKey)) continue;
        let group = observed.get(row.identityKey);
        if (!group) {
          group = { identityKey: row.identityKey, locations: [], registrationFailure: null };
          observed.set(row.identityKey, group);
        }
        group.locations.push({
          location: { daemonId, projectId: row.project.id }, hostname: source.hostname, project: row.project,
        });
        group.registrationFailure ??= this.interests.get(daemonId)?.registrationFailure ?? null;
      }
    }
    const next: WorkspaceProjects = {
      projects, observedProjects: [...observed.values()],
      summaries: Object.fromEntries(projectLogicalSummaries(projects, summaries, presentation)),
      sources: this.options.sources.all().map(source => source.getSnapshot()),
      catalogues: [...this.interests].map(([daemonId, interest]) => {
        const fact = interest.catalogue.getSnapshot();
        return { daemonId, phase: fact.phase, failure: interest.registrationFailure ?? fact.failure };
      }),
      navigation: [...this.interests].flatMap(([daemonId, interest]) => {
        const fact = interest.summaries?.getSnapshot();
        return fact ? [{ daemonId, phase: fact.phase, failure: fact.failure }] : [];
      }),
    };
    const groupPhases = [...placementPhases, ...summaryPhases,
      ...next.catalogues.map(source => source.phase)];
    const hasGroupFacts = placement.size > 0 || summaries.size > 0;
    const nextGroups = {
      data: projectLogicalGroups(projects, next.summaries, placement, presentation),
      phase: groupPhases.some(phase => phase === "failed")
        ? hasGroupFacts ? "stale" as const : "failed" as const
        : groupPhases.some(phase => phase !== "current")
          ? hasGroupFacts ? "stale" as const : "pending" as const : "current" as const,
      failure: placementFailures[0]
        ?? next.catalogues.find(source => source.failure)?.failure
        ?? next.navigation.find(source => source.failure)?.failure ?? null,
    };
    const bindings = this.options.sources.all().map(source => {
      const value = this.interests.get(source.id)?.catalogue.getSnapshot().value;
      return { daemonId: source.id, attachedLocal: source.id === this.options.sources.attached?.id,
        aliases: value?.kind === "catalogue" ? value.catalogue?.aliases ?? [] : [] };
    });
    const bindingChanged = !areDeeplyEqual(this.bindings, bindings);
    if (bindingChanged) this.bindings = bindings;
    if (areDeeplyEqual(this.snapshot, next) && areDeeplyEqual(this.groups, nextGroups) && !bindingChanged) return;
    if (!areDeeplyEqual(this.snapshot, next)) this.snapshot = next;
    this.groups = nextGroups;
    for (const listener of [...this.listeners]) {
      try { listener(); }
      catch (error) {
        this.options.warn(`Workspace subscriber failed: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
      }
    }
  }
}
