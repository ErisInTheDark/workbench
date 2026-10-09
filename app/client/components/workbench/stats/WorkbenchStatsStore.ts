/*
 * Exports:
 * - StatsActivityMetric: activity and breakdown measure.
 * - StatsSectionName: independently observed stats panels; `overview` is usage over the whole range, ignoring a picked period.
 * - StatsSectionSnapshot: one panel's latest data, retained across request changes, with its loading and refinement state.
 * - StatsState: the view's filters, derived scope, and actions.
 * - StatsInputs: app-owned facts the view feeds the store (workspace, project scope, navigation callbacks).
 * - default WorkbenchStatsStore: own stats filters and lease one workspace observation per demanded section request.
 */
import type { MouseEvent } from "react";
import type { WorkbenchHarness, WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import type { z } from "zod";
import {
  STATS_TOKEN_TYPES,
  type StatsTokenType,
  type WorkbenchStatsRange,
  type WorkbenchStatsReadRequestSchema,
  type WorkbenchStatsSection,
  type WorkbenchStatsSectionData,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import type WorkbenchWorkspaceClient from "../../../workbench/app/WorkbenchWorkspaceClient";
import type { WorkspaceQueryHandle } from "../../../workbench/app/WorkbenchWorkspaceClient";
import { nextStatsPeriod, type StatsPeriodSelection } from "./stats-period";
import type { StatsProjectGroup, StatsProjectScope } from "./stats-project-scope";

export type StatsActivityMetric = "cost" | "tokens";
type SectionRequest = z.output<typeof WorkbenchStatsReadRequestSchema>;

export type StatsSectionName = "overview" | WorkbenchStatsSection;
type SectionOf<Name extends StatsSectionName> = Name extends "overview" ? "usage" : Name;

export interface StatsSectionSnapshot<Name extends StatsSectionName = StatsSectionName> {
  /** Data for the current request, or the last request's while the current one loads. */
  readonly data: WorkbenchStatsSectionData<SectionOf<Name>> | null;
  readonly failure: string | null;
  /** No data for the current request yet. */
  readonly loading: boolean;
  /** Published data is provisional (claim counts before rename history merges). */
  readonly refining: boolean;
}

type Project = WorkbenchProjectOption;

export interface StatsInputs {
  readonly workspace: WorkbenchWorkspaceClient | null;
  readonly scope: StatsProjectScope;
  readonly projects: readonly Project[];
  readonly addressFeedback: (projectId: string, prompt: string) => void;
  readonly navigateThread: (event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string) => void;
}

interface Filters {
  chosenMode: "selected" | "all" | null;
  focusedProject: string | null;
  metric: StatsActivityMetric;
  model: string | null;
  period: StatsPeriodSelection | null;
  provider: WorkbenchHarness | null;
  range: WorkbenchStatsRange;
  tokenTypes: StatsTokenType[];
  workspaceProject: string | null;
}

export interface StatsState {
  readonly mode: "selected" | "all";
  readonly range: WorkbenchStatsRange;
  readonly period: StatsPeriodSelection | null;
  readonly focusedProject: string | null;
  readonly provider: WorkbenchHarness | null;
  readonly model: string | null;
  readonly tokenTypes: readonly StatsTokenType[];
  readonly metric: StatsActivityMetric;
  /** Null reads every project on the daemon. */
  readonly projectIds: readonly string[] | null;
  readonly projects: readonly Project[];
  readonly scope: StatsProjectScope;
  /** Whether panels break figures down by project. */
  readonly showProjects: boolean;
  /** Projects the workspaces tab picks between: the sidebar selection, or every project when nothing is selected. */
  readonly workspaceProjects: readonly StatsProjectGroup[];
  /** The one project (with all its local folders) the workspaces tab's claims and feedback show. */
  readonly workspaceProject: StatsProjectGroup | null;
  readonly ready: boolean;
  projectName(projectId: string): string;
  setMode(mode: "selected" | "all"): void;
  setRange(range: WorkbenchStatsRange): void;
  pickPeriod(startedAt: number, extend: boolean): void;
  clearPeriod(): void;
  focusProject(projectId: string | null): void;
  setProvider(provider: WorkbenchHarness | null): void;
  setModel(provider: WorkbenchHarness, model: string | null): void;
  setTokenTypes(tokenTypes: StatsTokenType[]): void;
  setMetric(metric: StatsActivityMetric): void;
  setWorkspaceProject(id: string): void;
  addressFeedback(projectId: string, prompt: string): void;
  navigateThread(event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string): void;
}

interface Entry {
  readonly handle: WorkspaceQueryHandle<"stats">;
  readonly stop: () => void;
}

const PENDING: StatsSectionSnapshot = { data: null, failure: null, loading: true, refining: false };
const EMPTY_SCOPE: StatsProjectScope = { daemonId: null, elsewhere: [], groups: [], labels: [], names: new Map(), projectIds: [] };

function sameSnapshot(left: StatsSectionSnapshot, right: StatsSectionSnapshot) {
  return left.data === right.data && left.failure === right.failure && left.loading === right.loading && left.refining === right.refining;
}

/**
 * Panels lease the sections they show; the store keeps exactly one workspace observation per distinct demanded
 * request, so a tab only reads what it renders and identical requests (usage without a period, and the overview) share one.
 */
export default class WorkbenchStatsStore {
  #filters: Filters = {
    chosenMode: null, focusedProject: null, metric: "cost", model: null, period: null,
    provider: null, range: "7d", tokenTypes: [...STATS_TOKEN_TYPES], workspaceProject: null,
  };
  #inputs: StatsInputs = {
    workspace: null, scope: EMPTY_SCOPE, projects: [], addressFeedback: () => {}, navigateThread: () => {},
  };
  #state: StatsState;
  readonly #listeners = new Set<() => void>();
  readonly #leases = new Map<StatsSectionName, number>();
  readonly #sectionListeners = new Map<StatsSectionName, Set<() => void>>();
  readonly #keys = new Map<StatsSectionName, string | null>();
  readonly #entries = new Map<string, Entry>();
  readonly #snapshots = new Map<StatsSectionName, StatsSectionSnapshot>();
  readonly #retained = new Map<StatsSectionName, StatsSectionSnapshot["data"]>();
  readonly #failureListeners = new Set<() => void>();
  #failures: readonly string[] = [];
  #syncQueued = false;

  constructor() {
    this.#state = this.#buildState();
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  readonly getState = () => this.#state;

  /** The view feeds app facts each render; only meaningful changes rebuild state or re-request sections. */
  setInputs(inputs: StatsInputs) {
    const previous = this.#inputs;
    this.#inputs = inputs;
    const selection = (scope: StatsProjectScope) => `${scope.daemonId}\0${scope.projectIds.join("\0")}`;
    const changed = previous.workspace !== inputs.workspace || previous.projects !== inputs.projects
      || previous.scope.names !== inputs.scope.names || previous.scope.labels.join("\0") !== inputs.scope.labels.join("\0")
      || previous.scope.elsewhere.join("\0") !== inputs.scope.elsewhere.join("\0") || selection(previous.scope) !== selection(inputs.scope);
    if (!changed) return;
    // A changed sidebar selection replaces any project drilled into from the old one.
    if (selection(previous.scope) !== selection(inputs.scope)) this.#filters = { ...this.#filters, focusedProject: null };
    if (previous.workspace !== inputs.workspace) this.#closeEntries();
    this.#update();
  }

  /** Release every observation; leased sections reopen on their next subscription. */
  dispose() {
    this.#closeEntries();
  }

  subscribeSection(name: StatsSectionName, listener: () => void) {
    const listeners = this.#sectionListeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#sectionListeners.set(name, listeners);
    this.#leases.set(name, (this.#leases.get(name) ?? 0) + 1);
    this.#sync();
    return () => {
      listeners.delete(listener);
      this.#leases.set(name, Math.max(0, (this.#leases.get(name) ?? 1) - 1));
      // Remounts (tab switches, strict effects) re-lease before the microtask, so their observation survives.
      this.#queueSync();
    };
  }

  getSectionSnapshot<Name extends StatsSectionName>(name: Name): StatsSectionSnapshot<Name> {
    return (this.#snapshots.get(name) ?? PENDING) as unknown as StatsSectionSnapshot<Name>;
  }

  /** Distinct read failures across the sections on screen, for one status slot instead of a message per panel. */
  readonly subscribeFailures = (listener: () => void) => {
    this.#failureListeners.add(listener);
    return () => { this.#failureListeners.delete(listener); };
  };

  readonly getFailures = () => this.#failures;

  #setFilters(next: Partial<Filters>) {
    this.#filters = { ...this.#filters, ...next };
    this.#update();
  }

  #update() {
    this.#state = this.#buildState();
    for (const listener of [...this.#listeners]) listener();
    this.#sync();
  }

  #projectIds(): readonly string[] | null {
    const { focusedProject } = this.#filters;
    if (focusedProject) return [focusedProject];
    return this.#mode() === "all" ? null : this.#inputs.scope.projectIds;
  }

  #workspaceProjects(): readonly StatsProjectGroup[] {
    const { groups } = this.#inputs.scope;
    return groups.length ? groups
      : this.#inputs.projects.map((project) => ({ id: project.id, label: project.name, project, projectIds: [project.id] }));
  }

  /** A chosen project that left the selection falls back to the first one still selected. */
  #workspaceProject(): StatsProjectGroup | null {
    const projects = this.#workspaceProjects();
    return projects.find(({ id }) => id === this.#filters.workspaceProject) ?? projects[0] ?? null;
  }

  #mode(): "selected" | "all" {
    // The selection resolves after project facts load, so only an explicit choice overrides the default.
    return this.#filters.chosenMode ?? (this.#inputs.scope.projectIds.length ? "selected" : "all");
  }

  #buildState(): StatsState {
    const filters = this.#filters;
    const inputs = this.#inputs;
    const projectIds = this.#projectIds();
    const projectName = (projectId: string) => inputs.scope.names.get(projectId)
      ?? inputs.projects.find(({ id }) => id === projectId)?.name ?? projectId;
    return {
      focusedProject: filters.focusedProject,
      metric: filters.metric,
      mode: this.#mode(),
      model: filters.model,
      period: filters.period,
      projectIds,
      projects: inputs.projects,
      provider: filters.provider,
      range: filters.range,
      ready: Boolean(inputs.workspace && DaemonIdSchema.safeParse(inputs.scope.daemonId).success),
      scope: inputs.scope,
      showProjects: projectIds === null || projectIds.length > 1,
      tokenTypes: filters.tokenTypes,
      workspaceProject: this.#workspaceProject(),
      workspaceProjects: this.#workspaceProjects(),
      projectName,
      setMode: (chosenMode) => this.#setFilters({ chosenMode, focusedProject: null }),
      setRange: (range) => this.#setFilters({ range, period: null }),
      pickPeriod: (startedAt, extend) => this.#setFilters({ period: nextStatsPeriod(this.#filters.period, startedAt, extend) }),
      clearPeriod: () => this.#setFilters({ period: null }),
      focusProject: (focusedProject) => this.#setFilters({ focusedProject }),
      setProvider: (provider) => this.#setFilters({ provider, model: null }),
      setModel: (provider, model) => this.#setFilters({ model, provider: model ? provider : this.#filters.provider }),
      setTokenTypes: (tokenTypes) => this.#setFilters({ tokenTypes }),
      setMetric: (metric) => this.#setFilters({ metric }),
      setWorkspaceProject: (workspaceProject) => this.#setFilters({ workspaceProject }),
      addressFeedback: (projectId, prompt) => this.#inputs.addressFeedback(projectId, prompt),
      navigateThread: (event, projectId, threadId) => this.#inputs.navigateThread(event, projectId, threadId),
    };
  }

  /** Provider, model and token types narrow usage only; activity, limits and status always span the whole range. */
  #request(name: StatsSectionName): SectionRequest | null {
    if (!this.#state.ready) return null;
    const filters = this.#filters;
    const usage = name === "usage" || name === "overview";
    const wholeRange = name === "overview" || name === "limits" || name === "status";
    // Contention and feedback read as one project's story, so the workspaces tab shows a single project.
    const workspace = name === "claims" || name === "feedback";
    const projectIds = workspace ? this.#workspaceProject()?.projectIds ?? [] : this.#projectIds();
    return {
      model: usage ? filters.model : null,
      period: wholeRange || !filters.period ? null : { from: filters.period.from, to: filters.period.to },
      projectIds: projectIds === null ? null : [...projectIds],
      provider: usage ? filters.provider : null,
      range: filters.range,
      section: name === "overview" ? "usage" : name,
      tokenTypes: usage ? [...filters.tokenTypes] : [...STATS_TOKEN_TYPES],
    };
  }

  #queueSync() {
    if (this.#syncQueued) return;
    this.#syncQueued = true;
    queueMicrotask(() => {
      this.#syncQueued = false;
      this.#sync();
    });
  }

  #sync() {
    const workspace = this.#inputs.workspace;
    const daemonId = DaemonIdSchema.safeParse(this.#inputs.scope.daemonId).data;
    const desired = new Map<string, SectionRequest>();
    this.#keys.clear();
    for (const [name, leases] of this.#leases) {
      if (!leases) continue;
      const request = this.#request(name);
      // Request bodies are plain JSON built in a fixed key order, so their serialisation is a stable identity.
      const key = request && daemonId ? JSON.stringify([daemonId, request]) : null;
      this.#keys.set(name, key);
      if (key && request) desired.set(key, request);
    }
    for (const [key, entry] of this.#entries) {
      if (desired.has(key)) continue;
      entry.stop();
      this.#entries.delete(key);
    }
    if (workspace && daemonId) {
      for (const [key, request] of desired) {
        if (this.#entries.has(key)) continue;
        const handle = workspace.observe({ kind: "stats", daemonId, request });
        const unsubscribe = handle.subscribe(() => this.#entryChanged(key));
        this.#entries.set(key, { handle, stop: () => { unsubscribe(); handle.release(); } });
      }
    }
    for (const name of this.#keys.keys()) this.#refresh(name);
    this.#refreshFailures();
  }

  #refreshFailures() {
    const failures = [...new Set([...this.#keys.keys()].flatMap((name) => this.#snapshots.get(name)?.failure ?? []))];
    if (failures.length === this.#failures.length && failures.every((failure, index) => failure === this.#failures[index])) return;
    this.#failures = failures;
    for (const listener of [...this.#failureListeners]) listener();
  }

  #closeEntries() {
    for (const entry of this.#entries.values()) entry.stop();
    this.#entries.clear();
  }

  #entryChanged(key: string) {
    for (const [name, current] of this.#keys) if (current === key) this.#refresh(name);
    this.#refreshFailures();
  }

  #refresh(name: StatsSectionName) {
    const key = this.#keys.get(name);
    const snapshot = key ? this.#entries.get(key)?.handle.getSnapshot() : undefined;
    const value = snapshot?.value ?? null;
    const section = name === "overview" ? "usage" : name;
    const data = value?.data?.section === section ? value.data : null;
    if (data) this.#retained.set(name, data);
    const next: StatsSectionSnapshot = {
      data: data ?? this.#retained.get(name) ?? null,
      failure: snapshot?.failure ?? value?.failure ?? null,
      loading: !data,
      refining: Boolean(data) && value?.refinement === "pending",
    };
    const previous = this.#snapshots.get(name) ?? PENDING;
    if (sameSnapshot(previous, next)) return;
    this.#snapshots.set(name, next);
    for (const listener of [...this.#sectionListeners.get(name) ?? []]) listener();
  }
}
