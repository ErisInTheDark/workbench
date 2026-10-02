/*
 * Exports:
 * - default WorkbenchWorkspaceObservationController: own named, partial observations over daemon fact owners.
 */
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import {
  DaemonWorkspaceObserveSchema, WorkspaceReleaseSchema,
  type DaemonWorkspaceObserve, type DaemonWorkspaceObservation,
} from "workbench-shared/workbench/workspace/workspace-observation";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { hasUnarchivedSidebarWork, WorkbenchHarnessSchema } from "workbench-shared/workbench/thread/thread-state";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";
import type WorkbenchThreadIdentityController from "./WorkbenchThreadIdentityController";
import type WorkbenchThreadStateController from "./WorkbenchThreadStateController";
import type WorkbenchProjectSnapshotController from "./WorkbenchProjectSnapshotController";
import type { WorkbenchReloadDirtSnapshot } from "workbench-shared/reload/workbench-reload";
import type WorkbenchStatsController from "./stats/WorkbenchStatsController";
import type { WorkbenchStatsInvalidation } from "./stats/WorkbenchStatsObservation";

type Payload = {
  [Kind in DaemonWorkspaceObservation["kind"]]: Omit<
    Extract<DaemonWorkspaceObservation, { kind: Kind }>, "subscriptionId" | "generation" | "revision"
  >;
}[DaemonWorkspaceObservation["kind"]];

interface Observation<Client extends object> {
  client: Client;
  connectionId: string;
  request: DaemonWorkspaceObserve;
  value: DaemonWorkspaceObservation;
  cancellation: AbortController;
  dirty: Set<ProjectId>;
  work: Promise<void> | null;
  identityRead: Promise<void> | null;
  stopTree: (() => void) | null;
  stats: { invalidate(kind: WorkbenchStatsInvalidation): void; release(): void } | null;
}

function failure(error: unknown) {
  return (error instanceof Error ? error.message : "Workspace observation failed.")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
}

export default class WorkbenchWorkspaceObservationController<Client extends object> {
  private readonly observations = new Map<string, Observation<Client>>();
  private readonly unsubscribe: Array<() => void>;
  private closed = false;

  constructor(private readonly owners: {
    reload: { read(): WorkbenchReloadDirtSnapshot; subscribe(listener: () => void): () => void };
    catalogue: Pick<WorkbenchProjectCatalogController, "getFacts" | "subscribe">;
    identities: Pick<WorkbenchThreadIdentityController, "findThread" | "resolve" | "subscribe">;
    threads: Pick<WorkbenchThreadStateController,
      "peekProject" | "readProject" | "peekProjectSummary" | "getProjectThreadSummary" | "subscribeProjects" | "readWorkspaceThread">;
    projects: Pick<WorkbenchProjectSnapshotController, "observe" | "getCurrentUpdate">;
    stats?: Pick<WorkbenchStatsController, "observe">;
    publish(client: Client, observation: DaemonWorkspaceObservation): void;
    warn(message: string): void;
    cooperate?: () => Promise<void>;
  }) {
    this.unsubscribe = [
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
      client, connectionId, request, value: initial, cancellation: new AbortController(),
      dirty: new Set(), work: null, identityRead: null, stopTree: null, stats: null,
    };
    this.observations.set(key, observation);
    switch (request.query.kind) {
      case "runtime": break;
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
      case "summaries":
      case "projectPlacement":
      case "projectThreads":
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
    return observation.value;
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

  private initial(request: DaemonWorkspaceObserve): DaemonWorkspaceObservation {
    const envelope = { subscriptionId: request.subscriptionId, generation: request.generation, revision: 0 };
    const catalogue = this.owners.catalogue.getFacts();
    switch (request.query.kind) {
      case "runtime": return { ...envelope, kind: "runtime", phase: "current", failure: null, data: this.readReload() };
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
          return { projectId, phase: sidebar ? "current" as const : "pending" as const, failure: null, sidebar };
        }),
      };
      case "projectTree": {
        const project = this.owners.projects.getCurrentUpdate(request.query.projectId);
        return { ...envelope, kind: "projectTree", phase: project ? "current" : "pending", failure: null, project };
      }
      case "threadIdentity": return {
        ...envelope, kind: "threadIdentity", phase: "pending", failure: null, identity: null,
      };
      case "thread": return { ...envelope, kind: "thread", phase: "pending", failure: null, data: null };
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
    return query.kind === "projectThreads" ? query.projectIds
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
        const current = this.owners.threads.peekProjectSummary(id)
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
      const projects = selected.map(projectId => {
        const sidebar = this.owners.threads.peekProject(projectId);
        const retained = value.projects.find(project => project.projectId === projectId);
        if (sidebar) return { projectId, phase: "current" as const, failure: null, sidebar };
        observation.dirty.add(projectId);
        return retained ?? { projectId, phase: "pending" as const, failure: null, sidebar: null };
      });
      this.update(observation, {
        kind: "projectThreads", phase: observation.dirty.size ? "pending" : "current", failure: null, projects,
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
    const work = (async () => {
      while (this.active(observation) && observation.dirty.size) {
        await (this.owners.cooperate?.() ?? new Promise<void>(resolve => setImmediate(resolve)));
        if (!this.active(observation)) return;
        const projectId = observation.dirty.values().next().value;
        if (!projectId) return;
        try {
          if (observation.request.query.kind === "summaries") {
            const read = await this.owners.threads.getProjectThreadSummary(projectId);
            if (!this.active(observation)) return;
            const summary = this.owners.threads.peekProjectSummary(projectId) ?? read;
            observation.dirty.delete(projectId);
            if (observation.value.kind !== "summaries" || !this.selectedProjects(observation).includes(projectId)) continue;
            const value = observation.value;
            const failures = value.failures.filter(item => item.projectId !== projectId);
            this.update(observation, {
              kind: "summaries", phase: observation.dirty.size ? "pending"
                : failures.length ? "stale" : this.owners.catalogue.getFacts().phase,
              failure: failures[0]?.message ?? null,
              projects: [...value.projects.filter(project => project.projectId !== projectId), summary],
              pendingProjectIds: [...observation.dirty], failures,
            });
          } else if (observation.request.query.kind === "projectPlacement") {
            const read = await this.owners.threads.readProject(projectId);
            if (!this.active(observation)) return;
            const sidebar = this.owners.threads.peekProject(projectId) ?? read;
            observation.dirty.delete(projectId);
            if (observation.value.kind !== "projectPlacement" || !this.selectedProjects(observation).includes(projectId)) continue;
            const value = observation.value;
            const failures = value.failures.filter(item => item.projectId !== projectId);
            this.update(observation, {
              kind: "projectPlacement", phase: observation.dirty.size ? "pending"
                : failures.length ? "stale" : this.owners.catalogue.getFacts().phase,
              failure: failures[0]?.message ?? null,
              projects: [...value.projects.filter(project => project.projectId !== projectId),
                { projectId, hasUnarchivedWork: hasUnarchivedSidebarWork(sidebar.entries) }],
              pendingProjectIds: [...observation.dirty], failures,
            });
          } else if (observation.request.query.kind === "projectThreads") {
            const read = await this.owners.threads.readProject(projectId);
            if (!this.active(observation)) return;
            const sidebar = this.owners.threads.peekProject(projectId) ?? read;
            observation.dirty.delete(projectId);
            if (observation.value.kind !== "projectThreads" || !this.selectedProjects(observation).includes(projectId)) continue;
            const projects = observation.value.projects.map(project => project.projectId === projectId
              ? { projectId, phase: "current" as const, failure: null, sidebar } : project);
            const failed = projects.find(project => project.failure);
            this.update(observation, {
              kind: "projectThreads", phase: observation.dirty.size ? "pending" : failed ? "stale" : "current",
              failure: failed?.failure ?? null, projects,
            });
          } else return;
        } catch (error) {
          if (!this.active(observation)) return;
          observation.dirty.delete(projectId);
          const message = failure(error);
          this.owners.warn(`Workspace project observation failed: ${message}`);
          if (observation.value.kind === "summaries") {
            const value = observation.value;
            this.update(observation, {
              kind: "summaries", phase: value.projects.length ? "stale" : "failed", failure: message,
              projects: value.projects, pendingProjectIds: [...observation.dirty],
              failures: [...value.failures.filter(item => item.projectId !== projectId), { projectId, message }],
            });
          } else if (observation.value.kind === "projectPlacement") {
            const value = observation.value;
            this.update(observation, {
              kind: "projectPlacement", phase: value.projects.length ? "stale" : "failed", failure: message,
              projects: value.projects, pendingProjectIds: [...observation.dirty],
              failures: [...value.failures.filter(item => item.projectId !== projectId), { projectId, message }],
            });
          } else if (observation.value.kind === "projectThreads") {
            this.update(observation, {
              kind: "projectThreads", phase: "stale", failure: message,
              projects: observation.value.projects.map(project => project.projectId === projectId
                ? { ...project, phase: project.sidebar ? "stale" as const : "failed" as const, failure: message } : project),
            });
          }
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

  private identityChanged(threadId: WorkbenchThreadId) {
    for (const observation of this.observations.values()) {
      if (observation.request.query.kind === "threadIdentity"
        && (observation.request.query.threadId === ThreadReferenceSchema.parse(threadId)
          || observation.value.kind === "threadIdentity" && observation.value.identity?.threadId === threadId)) {
        this.readIdentity(observation);
      }
    }
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
          this.update(observation, { kind: "thread", phase: "current", failure: null, data });
        } catch (error) {
          if (!this.active(observation)) return;
          const message = failure(error);
          this.owners.warn(`Workspace thread observation failed: ${message}`);
          const data = observation.value.kind === "thread" ? observation.value.data : null;
          this.update(observation, { kind: "thread", phase: data ? "stale" : "failed", failure: message, data });
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
    const next = { ...payload, subscriptionId: observation.request.subscriptionId,
      generation: observation.request.generation, revision: observation.value.revision };
    if (areDeeplyEqual(observation.value, next)) return;
    observation.value = { ...next, revision: next.revision + 1 };
    try { this.owners.publish(observation.client, observation.value); }
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
