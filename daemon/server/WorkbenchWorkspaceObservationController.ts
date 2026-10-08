/*
 * Exports:
 * - default WorkbenchWorkspaceObservationController: own named, partial observations over daemon fact owners (incl. working-tree summaries rerun only when changed paths or claims move); publish typed keyed deltas after each first value.
 */
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  DaemonWorkspaceObserveSchema, WorkspaceReleaseSchema, daemonObservationShape,
  type DaemonWorkspaceObserve, type DaemonWorkspaceObservation,
} from "workbench-shared/workbench/workspace/workspace-observation";
import type { ThreadRuntime } from "workbench-shared/workbench/thread/thread-context-usage";
import { diffObservationValue, type ObservationDelta } from "workbench-shared/workbench/workspace/observation-patch";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import {
  hasUnarchivedSidebarWork, WorkbenchHarnessSchema, type WorkbenchProjectThreadSummary, type WorkbenchThreadSidebarSnapshot,
} from "workbench-shared/workbench/thread/thread-state";
import { coarseActivity, projectSidebarRow, projectSidebarRowSnapshot } from "workbench-shared/workbench/thread/thread-sidebar-row";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import type { WorkbenchReloadDirtSnapshot } from "workbench-shared/reload/workbench-reload";
import type WorkbenchStatsController from "./stats/WorkbenchStatsController";
import type WorkbenchWorkingTreeController from "./WorkbenchWorkingTreeController";
import type WorkbenchAccountLimitsController from "./WorkbenchAccountLimitsController";
import type { WorkbenchProjectStateUpdate } from "workbench-shared/workbench/project/project-state";
import type { WorkbenchStatsInvalidation } from "./stats/WorkbenchStatsObservation";

type Payload = {
  [Kind in DaemonWorkspaceObservation["kind"]]: Omit<
    Extract<DaemonWorkspaceObservation, { kind: Kind }>, "subscriptionId" | "generation" | "revision"
  >;
}[DaemonWorkspaceObservation["kind"]];

/** `null` change = a full value (first value or restore); otherwise a keyed delta onto `baseRevision`. */
export type DaemonObservationChange = { baseRevision: number; delta: ObservationDelta } | null;

interface Observation<Client extends object> {
  client: Client;
  connectionId: string;
  request: DaemonWorkspaceObserve;
  value: DaemonWorkspaceObservation;
  /** True while `observe` runs: its return value already carries these changes, so nothing is published. */
  opening: boolean;
  cancellation: AbortController;
  dirty: Set<ProjectId>;
  work: Promise<void> | null;
  identityRead: Promise<void> | null;
  stopTree: (() => void) | null;
  stats: { invalidate(kind: WorkbenchStatsInvalidation): void; release(): void } | null;
  /** Last seen inputs of a working-tree summary: changed paths and claims. A summary reruns only when one moves. */
  summaryInputs: { changes: string | null; claims: string | null } | null;
}

type ProjectListKind = "summaries" | "projectPlacement" | "projectThreads" | "archivedThreads";
const projectListKinds = new Set<string>(["summaries", "projectPlacement", "projectThreads", "archivedThreads"]);

function failure(error: unknown) {
  return (error instanceof Error ? error.message : "Workspace observation failed.")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
}

/** Newest archived top-level threads first; subagents stay with their parent's thread observation. */
function archivedRows(sidebar: WorkbenchThreadSidebarSnapshot, limit: number) {
  const archived = sidebar.entries.filter(entry => entry.entryKind === "thread" && entry.metadata.archived)
    .sort((left, right) => right.activityAt - left.activityAt);
  return { total: archived.length, rows: archived.slice(0, limit).map(entry => projectSidebarRow(entry)) };
}

function replaceProject<Item extends { projectId: string }>(items: readonly Item[], next: Item) {
  return items.some(item => item.projectId === next.projectId)
    ? items.map(item => item.projectId === next.projectId ? next : item) : [...items, next];
}

export default class WorkbenchWorkspaceObservationController<Client extends object> {
  private readonly observations = new Map<string, Observation<Client>>();
  private readonly unsubscribe: Array<() => void>;
  private closed = false;

  constructor(private readonly owners: {
    installationUpdate?: Pick<import("./WorkbenchInstallationUpdateController").default, "read" | "subscribe">;
    reload: { read(): WorkbenchReloadDirtSnapshot; subscribe(listener: () => void): () => void };
    catalogue: Pick<WorkbenchProjectCatalogController, "getFacts" | "subscribe">;
    identities: Pick<WorkbenchThreadIdentityController, "findThread" | "resolve" | "subscribe">;
    threads: Pick<WorkbenchThreadStateController,
      "peekProject" | "readProject" | "peekProjectSummary" | "getProjectThreadSummary" | "subscribeProjects"
      | "readWorkspaceThread" | "isThreadCompacting">;
    projects: Pick<WorkbenchProjectSnapshotController, "observe" | "getCurrentUpdate">;
    stats?: Pick<WorkbenchStatsController, "observe">;
    workingTree?: Pick<WorkbenchWorkingTreeController, "summary">;
    accountLimits?: Pick<WorkbenchAccountLimitsController, "observe">;
    /** Live per-thread provider facts; `subscribe` names threads whose runtime changed. */
    runtime?: {
      read(threadId: string, harness: string): Promise<ThreadRuntime>;
      readTokenUsage(threadId: string): Promise<ThreadRuntime["tokenUsage"]>;
      subscribe(listener: (threadId: string, change: Partial<ThreadRuntime> | null) => void): () => void;
    };
    publish(client: Client, observation: DaemonWorkspaceObservation, change: DaemonObservationChange): void;
    warn(message: string): void;
    cooperate?: () => Promise<void>;
  }) {
    this.unsubscribe = [
      ...(owners.installationUpdate ? [owners.installationUpdate.subscribe(() => {
        for (const observation of this.observations.values()) {
          if (observation.request.query.kind === "update") this.update(observation, {
            kind: "update", phase: "current", failure: null, data: owners.installationUpdate!.read(),
          });
        }
      })] : []),
      owners.reload.subscribe(() => {
        for (const observation of this.observations.values()) {
          if (observation.request.query.kind === "runtime") this.update(observation, {
            kind: "runtime", phase: "current", failure: null, data: this.readReload(),
          });
        }
      }),
      owners.catalogue.subscribe(() => this.catalogueChanged()),
      owners.identities.subscribe(threadId => this.identityChanged(threadId)),
      owners.threads.subscribeProjects(projectId => this.projectChanged(projectId)),
      ...(owners.runtime ? [owners.runtime.subscribe((threadId, change) => this.runtimeChanged(threadId, change))] : []),
    ];
  }

  observe(client: Client, connectionId: string, input: DaemonWorkspaceObserve, initialRevision = 0) {
    if (this.closed) throw new Error("Workspace observations are reloading.");
    const request = DaemonWorkspaceObserveSchema.parse(input);
    const key = this.key(connectionId, request.subscriptionId);
    const existing = this.observations.get(key);
    if (existing && request.generation <= existing.request.generation) {
      if (request.generation === existing.request.generation && areDeeplyEqual(request.query, existing.request.query)) {
        return existing.value;
      }
      throw new Error("Workspace observation arguments belong to an obsolete generation.");
    }
    if (existing) this.retire(existing);
    const initial = { ...this.initial(request), revision: initialRevision };
    const observation: Observation<Client> = {
      client, connectionId, request, value: initial, opening: true, cancellation: new AbortController(),
      dirty: new Set(), work: null, identityRead: null, stopTree: null, stats: null, summaryInputs: null,
    };
    this.observations.set(key, observation);
    try { this.start(observation); }
    finally { observation.opening = false; }
    return observation.value;
  }

  private start(observation: Observation<Client>) {
    const request = observation.request;
    switch (request.query.kind) {
      case "runtime": break;
      case "update": break;
      case "catalogue": break;
      case "threadIdentity": this.readIdentity(observation); break;
      case "thread": this.readThread(observation); break;
      case "projectTree":
        observation.stopTree = this.owners.projects.observe(request.query.projectId, project => {
          this.update(observation, { kind: "projectTree", phase: "current", failure: null, project });
        }, message => {
          const project = observation.value.kind === "projectTree" ? observation.value.project : null;
          this.update(observation, { kind: "projectTree", phase: project ? "stale" : "failed", failure: message, project });
        });
        break;
      case "accountLimits": {
        const limits = this.owners.accountLimits;
        if (!limits) {
          this.update(observation, { kind: "accountLimits", phase: "unavailable", failure: "Account limits are unavailable.", limits: null });
          break;
        }
        // Opening may answer synchronously (an unsupported provider); the value below covers that.
        let handle: ReturnType<typeof limits.observe> | null = null;
        handle = limits.observe(request.query.provider, () => {
          if (handle) this.update(observation, { kind: "accountLimits", ...handle.read() });
        });
        const opened = handle;
        observation.stopTree = () => opened.release();
        this.update(observation, { kind: "accountLimits", ...opened.read() });
        break;
      }
      case "workingTreeSummary": {
        const projectId = request.query.projectId;
        const changedPaths = (update: WorkbenchProjectStateUpdate | null) => update ? Object.keys(update.snapshot.changes).sort().join("\0") : null;
        observation.summaryInputs = {
          changes: changedPaths(this.owners.projects.getCurrentUpdate(projectId)), claims: this.claimsKey(projectId),
        };
        // The project snapshot loop already tracks Git changes; a summary rereads only when its changed paths move.
        observation.stopTree = this.owners.projects.observe(projectId, update => {
          const changes = changedPaths(update);
          if (!observation.summaryInputs || observation.summaryInputs.changes === changes) return;
          observation.summaryInputs.changes = changes;
          this.readSummary(observation);
        });
        this.readSummary(observation);
        break;
      }
      case "summaries":
      case "projectPlacement":
      case "projectThreads":
      case "archivedThreads":
        this.selectProjects(observation);
        break;
      case "stats":
        if (!this.owners.stats) {
          this.update(observation, { kind: "stats", phase: "unavailable", failure: "Statistics are unavailable.", claimsPhase: "unavailable", data: null });
          break;
        }
        observation.stats = this.owners.stats.observe(request.query.request, state => this.update(observation, { kind: "stats", ...state }));
        break;
    }
  }

  release(connectionId: string, input: { subscriptionId: string; generation: number }) {
    const request = WorkspaceReleaseSchema.parse(input);
    const observation = this.observations.get(this.key(connectionId, request.subscriptionId));
    if (observation?.request.generation === request.generation) this.retire(observation);
    return { released: true };
  }

  disconnect(connectionId: string) {
    for (const observation of this.observations.values()) {
      if (observation.connectionId === connectionId) this.retire(observation);
    }
  }

  /** Threads this client observes: requested references plus every thread in each observed family. */
  observedThreadIds(client: Client) {
    const ids = new Set<string>();
    for (const observation of this.observations.values()) {
      if (observation.client !== client || observation.request.query.kind !== "thread") continue;
      ids.add(observation.request.query.threadId);
      if (observation.value.kind !== "thread") continue;
      for (const entry of observation.value.data?.entries ?? []) {
        if (entry.entryKind !== "draft") ids.add(entry.identity.threadId);
      }
    }
    return ids;
  }

  captureInterests() {
    return [...this.observations.values()].map(({ client, connectionId, request, value }) => ({
      client, connectionId, request, revision: value.revision,
    }));
  }

  dispose() {
    this.closed = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    for (const observation of this.observations.values()) this.retire(observation);
  }

  /** Observers get lean rows without archived threads. */
  private sidebar(sidebar: WorkbenchThreadSidebarSnapshot, version?: 2) {
    return projectSidebarRowSnapshot(sidebar,
      version === 2 ? threadId => this.owners.threads.isThreadCompacting(threadId) : undefined);
  }

  /** Activity to ten seconds, so a running agent's stream of items is one summary tick per window. */
  private summary(summary: WorkbenchProjectThreadSummary): WorkbenchProjectThreadSummary {
    return {
      ...summary,
      lastThreadUpdateAt: summary.lastThreadUpdateAt === null ? null : coarseActivity(summary.lastThreadUpdateAt),
      unsettledThreads: summary.unsettledThreads.map(entry => ({ ...entry, activityAt: coarseActivity(entry.activityAt) })),
      pinnedThreads: summary.pinnedThreads.map(entry => ({ ...entry, activityAt: coarseActivity(entry.activityAt) })),
    };
  }

  private initial(request: DaemonWorkspaceObserve): DaemonWorkspaceObservation {
    const envelope = { subscriptionId: request.subscriptionId, generation: request.generation, revision: 0 };
    const catalogue = this.owners.catalogue.getFacts();
    switch (request.query.kind) {
      case "runtime": return { ...envelope, kind: "runtime", phase: "current", failure: null, data: this.readReload() };
      case "update": return { ...envelope, kind: "update", phase: this.owners.installationUpdate ? "current" : "pending",
        failure: null, data: this.owners.installationUpdate?.read() ?? null };
      case "catalogue": return {
        ...envelope, kind: "catalogue", phase: catalogue.phase, failure: catalogue.failure,
        catalogue: catalogue.catalogue, locations: catalogue.locations,
      };
      case "summaries": return {
        ...envelope, kind: "summaries", phase: "pending", failure: null,
        projects: [], pendingProjectIds: [], failures: [],
      };
      case "projectPlacement": return {
        ...envelope, kind: "projectPlacement", phase: "pending", failure: null,
        projects: [], pendingProjectIds: [], failures: [],
      };
      case "projectThreads": return {
        ...envelope, kind: "projectThreads", phase: "pending", failure: null,
        projects: request.query.projectIds.map(projectId => {
          const sidebar = this.owners.threads.peekProject(projectId);
          return { projectId, phase: sidebar ? "current" as const : "pending" as const, failure: null,
            sidebar: sidebar ? this.sidebar(sidebar) : null };
        }),
      };
      case "archivedThreads": {
        const limit = request.query.limit;
        return {
          ...envelope, kind: "archivedThreads", phase: "pending", failure: null,
          projects: request.query.projectIds.map(projectId => {
            const sidebar = this.owners.threads.peekProject(projectId);
            return sidebar ? { projectId, phase: "current" as const, failure: null, ...archivedRows(sidebar, limit) }
              : { projectId, phase: "pending" as const, failure: null, total: 0, rows: [] };
          }),
        };
      }
      case "projectTree": {
        const project = this.owners.projects.getCurrentUpdate(request.query.projectId);
        return { ...envelope, kind: "projectTree", phase: project ? "current" : "pending", failure: null, project };
      }
      case "threadIdentity": return {
        ...envelope, kind: "threadIdentity", phase: "pending", failure: null, identity: null,
      };
      case "thread": return { ...envelope, kind: "thread", phase: "pending", failure: null, data: null, runtime: {} };
      case "workingTreeSummary": return { ...envelope, kind: "workingTreeSummary", phase: "pending", failure: null, summary: null };
      case "accountLimits": return { ...envelope, kind: "accountLimits", phase: "pending", failure: null, limits: null };
      case "stats": return { ...envelope, kind: "stats", phase: "pending", failure: null, claimsPhase: "pending", data: null };
    }
  }

  private catalogueChanged() {
    const facts = this.owners.catalogue.getFacts();
    for (const observation of this.observations.values()) {
      if (observation.request.query.kind === "catalogue") {
        this.update(observation, {
          kind: "catalogue", phase: facts.phase, failure: facts.failure,
          catalogue: facts.catalogue, locations: facts.locations,
        });
      } else if (observation.request.query.kind === "summaries"
        || observation.request.query.kind === "projectPlacement") this.selectProjects(observation);
    }
  }

  private readReload() {
    const snapshot = this.owners.reload.read();
    return { ...snapshot, dirtyScopes: snapshot.dirtyScopes.map(scope => ({
      ...scope, dependantScopes: scope.dependantScopes ?? [],
    })) };
  }

  private selectedProjects(observation: Observation<Client>): readonly ProjectId[] {
    const query = observation.request.query;
    return query.kind === "projectThreads" || query.kind === "archivedThreads" ? query.projectIds
      : query.kind === "summaries" || query.kind === "projectPlacement"
        ? this.owners.catalogue.getFacts().catalogue?.data.map(project => project.id) ?? []
      : [];
  }

  private selectProjects(observation: Observation<Client>) {
    const selected = this.selectedProjects(observation);
    const selectedSet = new Set(selected);
    for (const id of observation.dirty) if (!selectedSet.has(id)) observation.dirty.delete(id);
    const value = observation.value;
    if (value.kind === "summaries") {
      const projects = selected.flatMap(id => {
        const peeked = this.owners.threads.peekProjectSummary(id);
        const current = (peeked ? this.summary(peeked) : null)
          ?? value.projects.find(project => project.projectId === id);
        if (!current) observation.dirty.add(id);
        return current ? [current] : [];
      });
      this.update(observation, {
        kind: "summaries", phase: observation.dirty.size ? "pending" : this.owners.catalogue.getFacts().phase,
        failure: null, projects, pendingProjectIds: [...observation.dirty],
        failures: value.failures.filter(item => selectedSet.has(item.projectId)),
      });
    } else if (value.kind === "projectPlacement") {
      const projects = selected.flatMap(projectId => {
        const sidebar = this.owners.threads.peekProject(projectId);
        const retained = value.projects.find(project => project.projectId === projectId);
        if (!sidebar) observation.dirty.add(projectId);
        return sidebar
          ? [{ projectId, hasUnarchivedWork: hasUnarchivedSidebarWork(sidebar.entries) }]
          : retained ? [retained] : [];
      });
      this.update(observation, {
        kind: "projectPlacement", phase: observation.dirty.size ? "pending" : this.owners.catalogue.getFacts().phase,
        failure: null, projects, pendingProjectIds: [...observation.dirty],
        failures: value.failures.filter(item => selectedSet.has(item.projectId)),
      });
    } else if (value.kind === "projectThreads") {
      const version = observation.request.query.kind === "projectThreads"
        ? observation.request.query.sidebarRowVersion : undefined;
      const projects = selected.map(projectId => {
        const sidebar = this.owners.threads.peekProject(projectId);
        const retained = value.projects.find(project => project.projectId === projectId);
        if (sidebar) return { projectId, phase: "current" as const, failure: null,
          sidebar: this.sidebar(sidebar, version) };
        observation.dirty.add(projectId);
        return retained ?? { projectId, phase: "pending" as const, failure: null, sidebar: null };
      });
      this.update(observation, {
        kind: "projectThreads", phase: observation.dirty.size ? "pending" : "current", failure: null, projects,
      });
    } else if (value.kind === "archivedThreads" && observation.request.query.kind === "archivedThreads") {
      const limit = observation.request.query.limit;
      const projects = selected.map(projectId => {
        const sidebar = this.owners.threads.peekProject(projectId);
        const retained = value.projects.find(project => project.projectId === projectId);
        if (sidebar) return { projectId, phase: "current" as const, failure: null, ...archivedRows(sidebar, limit) };
        observation.dirty.add(projectId);
        return retained ?? { projectId, phase: "pending" as const, failure: null, total: 0, rows: [] };
      });
      this.update(observation, {
        kind: "archivedThreads", phase: observation.dirty.size ? "pending" : "current", failure: null, projects,
      });
    }
    this.drive(observation);
  }

  private projectChanged(projectId: ProjectId) {
    for (const observation of this.observations.values()) {
      const query = observation.request.query;
      // Thread activity in scope may carry new token usage; claims change through their own capture.
      if (query.kind === "stats") {
        const scope = query.request.projectIds;
        const inScope = !scope || scope.some(id => {
          const parsed = ProjectIdSchema.safeParse(id);
          return parsed.success && this.canonicalProject(parsed.data) === projectId;
        });
        if (inScope) observation.stats?.invalidate("usage");
        continue;
      }
      if (observation.request.query.kind === "thread"
        && this.canonicalProject(observation.request.query.projectId) === projectId) {
        this.readThread(observation);
        continue;
      }
      if (observation.request.query.kind === "workingTreeSummary"
        && this.canonicalProject(observation.request.query.projectId) === projectId) {
        // Thread activity also lands here; only a claim change can change which dirty paths are unclaimed.
        const claims = this.claimsKey(observation.request.query.projectId);
        if (observation.summaryInputs && observation.summaryInputs.claims !== claims) {
          observation.summaryInputs.claims = claims;
          this.readSummary(observation);
        }
        continue;
      }
      const selected = this.selectedProjects(observation).filter(id => this.canonicalProject(id) === projectId);
      if (!selected.length) continue;
      for (const id of selected) observation.dirty.add(id);
      this.drive(observation);
    }
  }

  private canonicalProject(projectId: ProjectId) {
    return this.owners.catalogue.getFacts().catalogue?.aliases.find(alias => alias.alias === projectId)?.projectId
      ?? projectId;
  }

  private drive(observation: Observation<Client>) {
    if (observation.work || !observation.dirty.size || !this.active(observation)) return;
    if (!projectListKinds.has(observation.request.query.kind)) return;
    const work = (async () => {
      while (this.active(observation) && observation.dirty.size) {
        await (this.owners.cooperate?.() ?? new Promise<void>(resolve => setImmediate(resolve)));
        if (!this.active(observation)) return;
        const projectId = observation.dirty.values().next().value;
        if (!projectId) return;
        try {
          await this.refreshProject(observation, observation.request.query.kind as ProjectListKind, projectId);
        } catch (error) {
          if (!this.active(observation)) return;
          observation.dirty.delete(projectId);
          this.failProject(observation, projectId, failure(error));
        }
      }
    })();
    observation.work = work;
    void work.then(() => {
      if (observation.work === work) observation.work = null;
      if (this.active(observation) && observation.dirty.size) this.drive(observation);
    }, error => {
      observation.work = null;
      if (this.active(observation)) this.owners.warn(`Workspace observation scheduling failed: ${failure(error)}`);
    });
  }

  private async refreshProject(observation: Observation<Client>, kind: ProjectListKind, projectId: ProjectId) {
    if (kind === "summaries") {
      const read = await this.owners.threads.getProjectThreadSummary(projectId);
      if (!this.active(observation)) return;
      const summary = this.summary(this.owners.threads.peekProjectSummary(projectId) ?? read);
      observation.dirty.delete(projectId);
      if (observation.value.kind !== "summaries" || !this.selectedProjects(observation).includes(projectId)) return;
      const value = observation.value;
      const failures = value.failures.filter(item => item.projectId !== projectId);
      this.update(observation, {
        kind: "summaries", phase: observation.dirty.size ? "pending"
          : failures.length ? "stale" : this.owners.catalogue.getFacts().phase,
        failure: failures[0]?.message ?? null,
        projects: replaceProject(value.projects, summary),
        pendingProjectIds: [...observation.dirty], failures,
      });
      return;
    }
    const read = await this.owners.threads.readProject(projectId);
    if (!this.active(observation)) return;
    const sidebar = this.owners.threads.peekProject(projectId) ?? read;
    observation.dirty.delete(projectId);
    if (!this.selectedProjects(observation).includes(projectId)) return;
    const value = observation.value;
    if (value.kind === "projectPlacement") {
      const failures = value.failures.filter(item => item.projectId !== projectId);
      this.update(observation, {
        kind: "projectPlacement", phase: observation.dirty.size ? "pending"
          : failures.length ? "stale" : this.owners.catalogue.getFacts().phase,
        failure: failures[0]?.message ?? null,
        projects: replaceProject(value.projects, { projectId, hasUnarchivedWork: hasUnarchivedSidebarWork(sidebar.entries) }),
        pendingProjectIds: [...observation.dirty], failures,
      });
    } else if (value.kind === "projectThreads") {
      const version = observation.request.query.kind === "projectThreads"
        ? observation.request.query.sidebarRowVersion : undefined;
      const projects = value.projects.map(project => project.projectId === projectId
        ? { projectId, phase: "current" as const, failure: null,
          sidebar: this.sidebar(sidebar, version) } : project);
      const failed = projects.find(project => project.failure);
      this.update(observation, {
        kind: "projectThreads", phase: observation.dirty.size ? "pending" : failed ? "stale" : "current",
        failure: failed?.failure ?? null, projects,
      });
    } else if (value.kind === "archivedThreads" && observation.request.query.kind === "archivedThreads") {
      const limit = observation.request.query.limit;
      const projects = value.projects.map(project => project.projectId === projectId
        ? { projectId, phase: "current" as const, failure: null, ...archivedRows(sidebar, limit) } : project);
      const failed = projects.find(project => project.failure);
      this.update(observation, {
        kind: "archivedThreads", phase: observation.dirty.size ? "pending" : failed ? "stale" : "current",
        failure: failed?.failure ?? null, projects,
      });
    }
  }

  private failProject(observation: Observation<Client>, projectId: ProjectId, message: string) {
    this.owners.warn(`Workspace project observation failed: ${message}`);
    const value = observation.value;
    if (value.kind === "summaries") {
      this.update(observation, {
        kind: "summaries", phase: value.projects.length ? "stale" : "failed", failure: message,
        projects: value.projects, pendingProjectIds: [...observation.dirty],
        failures: [...value.failures.filter(item => item.projectId !== projectId), { projectId, message }],
      });
    } else if (value.kind === "projectPlacement") {
      this.update(observation, {
        kind: "projectPlacement", phase: value.projects.length ? "stale" : "failed", failure: message,
        projects: value.projects, pendingProjectIds: [...observation.dirty],
        failures: [...value.failures.filter(item => item.projectId !== projectId), { projectId, message }],
      });
    } else if (value.kind === "projectThreads") {
      this.update(observation, {
        kind: "projectThreads", phase: "stale", failure: message,
        projects: value.projects.map(project => project.projectId === projectId
          ? { ...project, phase: project.sidebar ? "stale" as const : "failed" as const, failure: message } : project),
      });
    } else if (value.kind === "archivedThreads") {
      this.update(observation, {
        kind: "archivedThreads", phase: "stale", failure: message,
        projects: value.projects.map(project => project.projectId === projectId
          ? { ...project, phase: project.rows.length ? "stale" as const : "failed" as const, failure: message } : project),
      });
    }
  }

  private identityChanged(threadId: WorkbenchThreadId) {
    for (const observation of this.observations.values()) {
      if (observation.request.query.kind === "threadIdentity"
        && (observation.request.query.threadId === ThreadReferenceSchema.parse(threadId)
          || observation.value.kind === "threadIdentity" && observation.value.identity?.threadId === threadId)) {
        this.readIdentity(observation);
      }
    }
  }

  /** Runtime for each family thread: kept for threads already read, read once for newly listed ones. */
  private async familyRuntime(observation: Observation<Client>, entries: readonly { entryKind: string; identity?: { harness: string; threadId: string } }[]) {
    const previous = observation.value.kind === "thread" ? observation.value.runtime : {};
    const runtime: Record<string, ThreadRuntime> = {};
    for (const entry of entries) {
      if (entry.entryKind === "draft" || !entry.identity) continue;
      const { threadId, harness } = entry.identity;
      runtime[threadId] = previous[threadId] ?? await this.readRuntime(threadId, harness);
    }
    return runtime;
  }

  private async readRuntime(threadId: string, harness: string): Promise<ThreadRuntime> {
    if (!this.owners.runtime) return { tokenUsage: null, willAutoCompact: null };
    try { return await this.owners.runtime.read(threadId, harness); }
    catch (error) {
      this.owners.warn(`Workspace thread runtime read failed: ${failure(error)}`);
      return { tokenUsage: null, willAutoCompact: null };
    }
  }

  /** A family thread's runtime changed: apply pushed values, or reread its token usage, for each observation listing it. */
  private runtimeChanged(threadId: string, change: Partial<ThreadRuntime> | null) {
    const runtime = this.owners.runtime;
    if (!runtime) return;
    const listing = [...this.observations.values()].filter(observation =>
      observation.value.kind === "thread" && threadId in observation.value.runtime);
    if (!listing.length) return;
    const apply = (patch: Partial<ThreadRuntime>) => {
      for (const observation of listing) {
        if (!this.active(observation) || observation.value.kind !== "thread") continue;
        const current = observation.value.runtime[threadId];
        if (!current) continue;
        this.update(observation, { ...observation.value, runtime: { ...observation.value.runtime, [threadId]: { ...current, ...patch } } });
      }
    };
    if (change) { apply(change); return; }
    void runtime.readTokenUsage(threadId).then(tokenUsage => apply({ tokenUsage }),
      error => this.owners.warn(`Workspace thread token usage read failed: ${failure(error)}`));
  }

  private readThread(observation: Observation<Client>) {
    const query = observation.request.query;
    if (query.kind !== "thread") return;
    if (observation.work) { observation.dirty.add(query.projectId); return; }
    const work = (async () => {
      do {
        observation.dirty.delete(query.projectId);
        try {
          const identity = this.owners.identities.findThread(query.threadId)
            ?? await this.owners.identities.resolve({ threadId: query.threadId });
          if (!identity || identity.projectId !== this.canonicalProject(query.projectId)) throw new Error("Thread does not belong to this project.");
          const data = await this.owners.threads.readWorkspaceThread({
            projectId: query.projectId, subscriptionId: observation.request.subscriptionId,
            target: { kind: "provider", threadId: identity.threadId },
          });
          const runtime = await this.familyRuntime(observation, data.entries);
          if (!this.active(observation)) return;
          this.update(observation, { kind: "thread", phase: "current", failure: null, runtime,
            data: { ...data, entries: data.entries.map(entry => ({ ...entry, activityAt: coarseActivity(entry.activityAt) })) } });
        } catch (error) {
          if (!this.active(observation)) return;
          const message = failure(error);
          this.owners.warn(`Workspace thread observation failed: ${message}`);
          const value = observation.value.kind === "thread" ? observation.value : null;
          this.update(observation, { kind: "thread", phase: value?.data ? "stale" : "failed", failure: message,
            data: value?.data ?? null, runtime: value?.runtime ?? {} });
        }
      } while (this.active(observation) && observation.dirty.has(query.projectId));
    })();
    observation.work = work;
    void work.then(() => {
      if (observation.work === work) observation.work = null;
      if (this.active(observation) && observation.dirty.has(query.projectId)) this.readThread(observation);
    }, error => {
      observation.work = null;
      if (this.active(observation)) this.owners.warn(`Workspace thread scheduling failed: ${failure(error)}`);
    });
  }

  /** Live and stashed claims of the project's threads, as a comparable key; null before the project is loaded. */
  private claimsKey(projectId: ProjectId) {
    const sidebar = this.owners.threads.peekProject(projectId);
    if (!sidebar) return null;
    return sidebar.entries.flatMap(entry => entry.entryKind === "draft" || !entry.gitArc ? [] : [
      `${entry.identity.threadId}:${entry.gitArc.phase}:${entry.gitArc.claimedPaths.join("\0")}:${(entry.gitArc.stashedPaths ?? []).join("\0")}`,
    ]).sort().join("\n");
  }

  /** One summary read at a time; a trigger during a read reruns once it finishes. */
  private readSummary(observation: Observation<Client>) {
    const query = observation.request.query;
    if (query.kind !== "workingTreeSummary") return;
    if (!this.owners.workingTree) {
      this.update(observation, { kind: "workingTreeSummary", phase: "unavailable", failure: "Working tree is unavailable.", summary: null });
      return;
    }
    if (observation.work) { observation.dirty.add(query.projectId); return; }
    const workingTree = this.owners.workingTree;
    const work = (async () => {
      do {
        observation.dirty.delete(query.projectId);
        try {
          const summary = await workingTree.summary(query.projectId);
          if (!this.active(observation)) return;
          this.update(observation, { kind: "workingTreeSummary", phase: "current", failure: null, summary });
        } catch (error) {
          if (!this.active(observation)) return;
          const message = failure(error);
          this.owners.warn(`Workspace working-tree summary failed: ${message}`);
          const summary = observation.value.kind === "workingTreeSummary" ? observation.value.summary : null;
          this.update(observation, { kind: "workingTreeSummary", phase: summary ? "stale" : "failed", failure: message, summary });
        }
      } while (this.active(observation) && observation.dirty.has(query.projectId));
    })();
    observation.work = work;
    void work.then(() => {
      if (observation.work === work) observation.work = null;
      if (this.active(observation) && observation.dirty.has(query.projectId)) this.readSummary(observation);
    }, error => {
      observation.work = null;
      if (this.active(observation)) this.owners.warn(`Workspace working-tree summary scheduling failed: ${failure(error)}`);
    });
  }

  private readIdentity(observation: Observation<Client>) {
    const query = observation.request.query;
    if (query.kind !== "threadIdentity" || observation.identityRead) return;
    const work = (async () => {
      try {
        const read = this.owners.identities.findThread(query.threadId)
          ?? await this.owners.identities.resolve({ threadId: query.threadId });
        if (!this.active(observation)) return;
        const record = this.owners.identities.findThread(query.threadId)
          ?? (read ? this.owners.identities.findThread(read.threadId) ?? read : null);
        const harness = record?.bindings[0]?.harness;
        if (record && !harness) throw new Error("The admitted thread has no provider identity.");
        this.update(observation, {
          kind: "threadIdentity", phase: "current", failure: null,
          identity: record ? {
            threadId: record.threadId, projectId: record.projectId,
            harness: WorkbenchHarnessSchema.parse(harness),
          } : null,
        });
      } catch (error) {
        if (!this.active(observation)) return;
        const message = failure(error);
        this.owners.warn(`Workspace identity observation failed: ${message}`);
        this.update(observation, { kind: "threadIdentity", phase: "failed", failure: message, identity: null });
      }
    })();
    observation.identityRead = work;
    void work.then(() => {
      if (observation.identityRead === work) observation.identityRead = null;
    }, error => {
      observation.identityRead = null;
      if (this.active(observation)) this.owners.warn(`Workspace identity publication failed: ${failure(error)}`);
    });
  }

  private update(observation: Observation<Client>, payload: Payload) {
    if (!this.active(observation)) return;
    const previous = observation.value;
    const next = { ...payload, subscriptionId: observation.request.subscriptionId,
      generation: observation.request.generation, revision: previous.revision } as DaemonWorkspaceObservation;
    // The keyed diff doubles as the change test: no delta means nothing observable changed.
    const delta = diffObservationValue(previous, next, daemonObservationShape(next.kind));
    if (!delta) return;
    observation.value = { ...next, revision: previous.revision + 1 };
    if (observation.opening) return;
    try { this.owners.publish(observation.client, observation.value, { baseRevision: previous.revision, delta }); }
    catch (error) { this.owners.warn(`Workspace observation delivery failed: ${failure(error)}`); }
  }

  private active(observation: Observation<Client>) {
    return !this.closed && !observation.cancellation.signal.aborted
      && this.observations.get(this.key(observation.connectionId, observation.request.subscriptionId)) === observation;
  }

  private retire(observation: Observation<Client>) {
    observation.cancellation.abort();
    observation.stopTree?.();
    observation.stats?.release();
    observation.dirty.clear();
    this.observations.delete(this.key(observation.connectionId, observation.request.subscriptionId));
  }

  private key(connectionId: string, subscriptionId: string) {
    return `${connectionId}\0${subscriptionId}`;
  }
}
