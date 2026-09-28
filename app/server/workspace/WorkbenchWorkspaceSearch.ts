/*
 * Exports:
 * - default WorkbenchWorkspaceSearch: share demanded searches and publish independently completed source results.
 */
import {
  WorkbenchSearchResponseSchema, type WorkbenchSearchRequest, type WorkbenchSearchResponse,
} from "workbench-shared/workbench/search/workbench-search";
import type { WorkspaceObservation } from "workbench-shared/workbench/workspace/workspace-observation";
import type { ProjectId } from "workbench-shared/workbench/identity";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import reportClientSchemaError from "workbench-shared/workbench/report-client-schema-error";
import type WorkbenchDaemonSource from "./WorkbenchDaemonSource";
import type WorkbenchDaemonSources from "./WorkbenchDaemonSources";
import type WorkbenchPresentationController from "../state/WorkbenchPresentationController";

type Result = Omit<Extract<WorkspaceObservation, { kind: "search" }>, "subscriptionId" | "generation" | "revision">;
type Source = Pick<WorkbenchDaemonSource, "id" | "available" | "getSnapshot" | "retain" | "request">;
interface Job {
  source: Source;
  projectId: ProjectId | null;
  release(): void;
  generation: number | null;
  cancellation: AbortController | null;
  response: WorkbenchSearchResponse | null;
  failure: string | null;
}
interface Interest {
  request: WorkbenchSearchRequest;
  listeners: Map<object, () => void>;
  jobs: Map<string, Job>;
  value: Result;
}

export default class WorkbenchWorkspaceSearch {
  private readonly interests = new Set<Interest>();
  private readonly stop: Array<() => void>;
  private refreshing = false;
  private dirty = false;
  private disposed = false;

  constructor(private readonly options: {
    sources: Pick<WorkbenchDaemonSources, "subscribe"> & { all(): Source[]; readonly attached: Source | null };
    presentation: Pick<WorkbenchPresentationController, "read" | "subscribe">;
    warn(message: string): void;
  }) {
    this.stop = [
      options.sources.subscribe(() => this.refresh()),
      options.presentation.subscribe(() => this.refresh()),
    ];
  }

  observe(request: WorkbenchSearchRequest, changed: () => void) {
    if (this.disposed) throw new Error("Workspace search is closed.");
    let interest = [...this.interests].find(item => areDeeplyEqual(item.request, request));
    if (!interest) {
      interest = { request: { ...request }, listeners: new Map(), jobs: new Map(),
        value: { kind: "search", phase: "pending", failure: null, data: { results: [] }, sources: [] } };
      this.interests.add(interest);
    }
    const retained = interest;
    const token = {};
    retained.listeners.set(token, changed);
    this.refresh();
    return {
      getSnapshot: () => retained.value,
      release: () => {
        if (!retained.listeners.delete(token) || retained.listeners.size) return;
        this.retire(retained);
      },
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const stop of this.stop) stop();
    for (const interest of this.interests) this.retire(interest);
  }

  private retire(interest: Interest) {
    this.interests.delete(interest);
    for (const job of interest.jobs.values()) {
      job.cancellation?.abort();
      job.release();
    }
    interest.jobs.clear();
  }

  private refresh() {
    if (this.disposed) return;
    this.dirty = true;
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        for (const interest of this.interests) this.reconcile(interest);
      }
    } finally { this.refreshing = false; }
  }

  private reconcile(interest: Interest) {
    const presentation = this.options.presentation.read();
    const logical = presentation.projects.find(project => project.id === interest.request.projectId);
    const targets = this.options.sources.all().flatMap<{ source: Source; projectId: ProjectId | null }>(source => {
      const locations = presentation.locations.filter(location => location.target.daemonId === source.id
        && (logical ? location.logicalProjectId === logical.id
          : location.target.projectId === interest.request.projectId));
      return interest.request.projectId
        ? locations.map(location => ({ source, projectId: location.target.projectId }))
        : [{ source, projectId: null }];
    });
    const keys = new Set(targets.map(target => `${target.source.id}/${target.projectId ?? ""}`));
    for (const [key, job] of interest.jobs) {
      if (keys.has(key) && targets.some(target => target.source === job.source)) continue;
      interest.jobs.delete(key);
      job.cancellation?.abort();
      job.release();
    }
    for (const target of targets) {
      const key = `${target.source.id}/${target.projectId ?? ""}`;
      let job = interest.jobs.get(key);
      if (!job) {
        job = { ...target, release: () => {}, generation: null, cancellation: null, response: null, failure: null };
        interest.jobs.set(key, job);
        job.release = target.source.retain();
      }
      const source = job.source.getSnapshot();
      if (!job.source.available) {
        job.cancellation?.abort();
        job.cancellation = null;
        job.generation = null;
        if (source.connection === "revoked") job.response = null;
        continue;
      }
      if (job.generation === source.generation) continue;
      job.cancellation?.abort();
      job.generation = source.generation;
      job.failure = null;
      const cancellation = new AbortController();
      job.cancellation = cancellation;
      const current = job;
      void job.source.request<WorkbenchSearchResponse>("search/query", {
        ...interest.request, projectId: job.projectId,
      }, {}, { signal: cancellation.signal }).then(value => {
        if (!this.active(interest, key, current, cancellation)) return;
        const parsed = WorkbenchSearchResponseSchema.safeParse(value);
        if (!parsed.success) {
          reportClientSchemaError("Rejected daemon search response", parsed.error);
          throw new Error("The daemon returned invalid search results.");
        }
        current.response = parsed.data;
      }).catch(error => {
        if (!this.active(interest, key, current, cancellation)) return;
        current.failure = (error instanceof Error ? error.message : "Source search failed.")
          .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 512);
        this.options.warn(`Workspace search failed: ${current.failure}`);
      }).finally(() => {
        if (!this.active(interest, key, current, cancellation)) return;
        current.cancellation = null;
        this.refresh();
      });
    }
    const sources: Result["sources"] = [];
    const results: Result["data"]["results"] = [];
    const seen = new Set<string>();
    for (const job of interest.jobs.values()) {
      const source = job.source.getSnapshot();
      const failure = job.failure ?? source.failure;
      const phase = !job.source.available
        ? source.connection === "revoked" ? "unavailable" : job.response ? "stale" : failure ? "failed" : "pending"
        : job.cancellation ? job.response ? "stale" : "pending" : job.failure ? "failed" : "current";
      sources.push({ daemonId: source.daemonId, projectId: job.projectId, phase, failure });
      for (const hit of job.response?.results ?? []) {
        if (hit.kind === "action") {
          if (job.source.id === this.options.sources.attached?.id && !seen.has(hit.id)) {
            seen.add(hit.id);
            results.push({ hit });
          }
          continue;
        }
        if (hit.kind === "projectSetting" && job.source.id !== this.options.sources.attached?.id) continue;
        const location = presentation.locations.find(item =>
          item.target.daemonId === job.source.id && item.target.projectId === hit.projectId);
        if (!location) continue;
        const key = hit.kind === "project" ? location.logicalProjectId : `${job.source.id}/${hit.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ hit: { ...hit, id: `${job.source.id}:${hit.id}` },
          source: location.target, logicalProjectId: location.logicalProjectId });
      }
    }
    const failed = sources.filter(source => source.failure || source.phase === "unavailable").length;
    const pending = sources.some(source => source.phase === "pending" || source.phase === "stale");
    const next: Result = {
      kind: "search", sources,
      phase: !sources.length || pending ? results.length ? "stale" : "pending"
        : failed ? results.length ? "stale" : "failed" : "current",
      failure: sources.find(source => source.failure)?.failure ?? null,
      data: { results: results.slice(0, 50),
        ...(failed ? { warning: `Results are incomplete: ${failed} source queries are unavailable.` } : {}) },
    };
    if (areDeeplyEqual(interest.value, next)) return;
    interest.value = next;
    for (const listener of interest.listeners.values()) {
      try { listener(); }
      catch (error) {
        this.options.warn(`Search subscriber failed: ${error instanceof Error ? error.message.slice(0, 512) : "Unexpected failure."}`);
      }
    }
  }

  private active(interest: Interest, key: string, job: Job, cancellation: AbortController) {
    return !this.disposed && this.interests.has(interest) && interest.jobs.get(key) === job
      && job.cancellation === cancellation && !cancellation.signal.aborted;
  }
}
