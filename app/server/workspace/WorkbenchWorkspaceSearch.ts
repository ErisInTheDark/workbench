/*
 * Exports:
 * - default WorkbenchWorkspaceSearch: share demanded searches, run one search at a time per daemon (skipping superseded
 *   ones), and publish independently completed source results, filtered and merged by score into kind sections.
 */
import {
  WORKBENCH_SEARCH_RESULT_LIMIT, WorkbenchSearchResponseSchema, arrangeWorkbenchSearchResults,
  type WorkbenchSearchCorrection, type WorkbenchSearchRequest, type WorkbenchSearchResponse, type WorkbenchSearchResult,
} from "workbench-shared/workbench/search/workbench-search";
import type { WorkspaceObservation } from "workbench-shared/workbench/workspace/workspace-observation";
import type { ProjectId } from "workbench-shared/workbench/identity";
import { areDeeplyEqual } from "workbench-shared/workbench/deep-equality";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
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

/** Older daemons title file hits with their whole path; every daemon's hits read as file name over folder. */
function fileNames(hit: Extract<WorkbenchSearchResult, { kind: "file" }>) {
  const slash = hit.path.lastIndexOf("/");
  return { ...hit, title: hit.path.slice(slash + 1), detail: hit.path.slice(0, Math.max(0, slash)) };
}

export default class WorkbenchWorkspaceSearch {
  private readonly interests = new Set<Interest>();
  private readonly lanes = new Map<Source["id"], { busy: boolean; waiting: Array<() => void> }>();
  private readonly stop: Array<() => void>;
  private refreshing = false;
  private dirty = false;
  private disposed = false;

  constructor(private readonly options: {
    sources: Pick<WorkbenchDaemonSources, "subscribe"> & { all(): Source[]; readonly attached: Source | null };
    presentation: Pick<WorkbenchPresentationController, "read" | "subscribe">;
    warn(message: string): void;
    canProject?(): boolean;
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

  resumeProjection() {
    this.refresh();
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
    if (this.disposed || this.options.canProject?.() === false) return;
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
      void this.inLane(job.source, cancellation.signal, () => current.source.request<WorkbenchSearchResponse>("search/query", {
        ...interest.request, projectId: current.projectId,
      })).then(value => {
        if (!this.active(interest, key, current, cancellation)) return;
        const conformed = conformToZodSchema(WorkbenchSearchResponseSchema, value);
        if (!conformed.success) throw new Error("The daemon returned invalid search results.");
        if (conformed.discardedPaths.length) {
          this.options.warn(`Workspace search dropped ${conformed.discardedPaths.length} malformed daemon results.`);
        }
        current.response = conformed.data;
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
    const corrections = new Map<string, WorkbenchSearchCorrection>();
    const seen = new Set<string>();
    const { kinds, projectOnly } = interest.request;
    const typed = interest.request.query.trim() !== "";
    for (const job of interest.jobs.values()) {
      const source = job.source.getSnapshot();
      const failure = job.failure ?? source.failure;
      const phase = !job.source.available
        ? source.connection === "revoked" ? "unavailable" : job.response ? "stale" : failure ? "failed" : "pending"
        : job.cancellation ? job.response ? "stale" : "pending" : job.failure ? "failed" : "current";
      sources.push({ daemonId: source.daemonId, projectId: job.projectId, phase, failure });
      for (const correction of job.response?.corrections ?? []) corrections.set(`${correction.from}\n${correction.to}`, correction);
      for (const hit of job.response?.results ?? []) {
        // Older daemons ignore filters they do not know and list every file for an empty query, so the merge enforces both.
        if (kinds && !kinds.includes(hit.kind)) continue;
        if (!typed && (hit.kind === "file" || hit.kind === "projectSetting")) continue;
        if (projectOnly && job.projectId && hit.kind === "thread" && hit.projectId !== job.projectId) continue;
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
        // Checkouts of one logical project hold the same files; show each path once.
        const key = hit.kind === "project" ? location.logicalProjectId
          : hit.kind === "file" ? `${location.logicalProjectId}/file/${hit.path}` : `${job.source.id}/${hit.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ hit: { ...(hit.kind === "file" ? fileNames(hit) : hit), id: `${job.source.id}:${hit.id}` },
          source: location.target, logicalProjectId: location.logicalProjectId });
      }
    }
    const failed = (source: Result["sources"][number]) => Boolean(source.failure) || source.phase === "unavailable";
    const pending = sources.some(source => source.phase === "pending" || source.phase === "stale");
    // One unreachable daemon only narrows the answer; the search failed only when no source could answer.
    const next: Result = {
      kind: "search", sources,
      phase: !sources.length || pending ? results.length ? "stale" : "pending"
        : sources.every(failed) ? "failed" : "current",
      failure: sources.find(source => source.failure)?.failure ?? null,
      data: { results: arrangeWorkbenchSearchResults(results, result => result.hit, kinds).slice(0, WORKBENCH_SEARCH_RESULT_LIMIT),
        ...(corrections.size ? { corrections: [...corrections.values()].slice(0, 16) } : {}) },
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

  /**
   * One search at a time per daemon, in demand order. Each turn waits for the daemon's real answer, not its own
   * cancellation, so superseded queries still waiting their turn are skipped instead of piling up on the daemon.
   */
  private inLane<Value>(source: Source, signal: AbortSignal, send: () => Promise<Value>) {
    const lane = this.lanes.get(source.id) ?? { busy: false, waiting: [] };
    this.lanes.set(source.id, lane);
    const next = () => lane.waiting.shift()?.();
    return new Promise<Value>((resolve, reject) => {
      const start = () => {
        if (signal.aborted) {
          reject(signal.reason);
          next();
          return;
        }
        lane.busy = true;
        void send().then(resolve, reject).finally(() => {
          lane.busy = false;
          next();
        });
      };
      if (lane.busy) lane.waiting.push(start);
      else start();
    });
  }

  private active(interest: Interest, key: string, job: Job, cancellation: AbortController) {
    return !this.disposed && this.interests.has(interest) && interest.jobs.get(key) === job
      && job.cancellation === cancellation && !cancellation.signal.aborted;
  }
}
