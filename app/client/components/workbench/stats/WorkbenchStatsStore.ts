/*
 * Exports:
 * - StatsActivityMetric: activity and breakdown measure.
 * - StatsSectionName: independently observed stats panels; `overview` is usage over the whole range, ignoring a picked period.
 * - StatsSectionSnapshot: one panel's latest data, retained across request changes, with its loading and refinement state.
 * - StatsState: the view's filters, derived scope, and actions.
 * - StatsThreadLocation/StatsProjectLocation: where a stats row's thread or project lives once merged across machines.
 * - StatsFeedbackReport/StatsFeedbackReportSnapshot: one feedback report addressed through the thread that filed it, and its read state.
 * - StatsInputs: app-owned facts the stats view feeds the store (project scope, routes).
 * - default WorkbenchStatsStore: app-wide stats owner; own stats filters, lease one cross-machine workspace observation per demanded
 *   section request, and lease single feedback report reads.
 */
import type { MouseEvent } from "react";
import type { WorkbenchHarness, WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema, LogicalProjectIdSchema, ProjectIdSchema, ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkspaceProjectReference } from "workbench-shared/workbench/workspace/workspace-observation";
import type { WorkbenchFeedbackItem } from "workbench-shared/workbench/stats/workbench-stats-feedback-contract";
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
import type { WorkspaceQueryHandle, WorkspaceQuerySnapshot } from "../../../workbench/app/WorkbenchWorkspaceClient";
import { nextStatsPeriod, type StatsPeriodSelection } from "./stats-period";
import { statsLocationKey, type StatsProjectGroup, type StatsProjectScope } from "./stats-project-scope";

export type StatsActivityMetric = "cost" | "tokens";
type SectionRequest = Omit<z.output<typeof WorkbenchStatsReadRequestSchema>, "projectIds">;
interface StatsQuery { projects: WorkspaceProjectReference[] | null; request: SectionRequest }

/** A stats row's thread, on whichever machine holds it. */
export interface StatsThreadLocation {
  readonly daemonId?: string | null;
  readonly projectId: string;
  readonly threadId: string;
}

/** A stats row's project; merged rows name their logical project. */
export interface StatsProjectLocation {
  readonly daemonId?: string | null;
  readonly logicalProjectId?: string | null;
  readonly projectId: string;
}

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

/** Report ids are only unique per daemon, so a report is addressed through the thread that filed it. */
export interface StatsFeedbackReport {
  readonly feedbackId: number;
  readonly threadId: string;
}

export type StatsFeedbackReportSnapshot =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly item: WorkbenchFeedbackItem }
  | { readonly status: "deleted" }
  | { readonly status: "failed"; readonly failure: string };

export interface StatsInputs {
  readonly scope: StatsProjectScope;
  readonly projects: readonly Project[];
  readonly addressFeedback: (projectId: string, prompt: string) => void;
  readonly openRoute: (event: MouseEvent<HTMLAnchorElement>, route: WorkbenchRoute) => void;
  /** Local threads open in their project; others open by id through their logical project. */
  readonly threadRoute: (thread: StatsThreadLocation, logicalProjectId: string | null) => WorkbenchRoute;
}

interface FocusedProject {
  readonly key: string;
  readonly label: string;
  readonly reference: WorkspaceProjectReference;
}

interface Filters {
  chosenMode: "selected" | "all" | null;
  focusedProject: FocusedProject | null;
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
  readonly focusedProject: FocusedProject | null;
  readonly provider: WorkbenchHarness | null;
  readonly model: string | null;
  readonly tokenTypes: readonly StatsTokenType[];
  readonly metric: StatsActivityMetric;
  /** Null reads every project on every machine. */
  readonly references: readonly WorkspaceProjectReference[] | null;
  /** The attached daemon's catalogue. */
  readonly projects: readonly Project[];
  readonly scope: StatsProjectScope;
  /** Whether panels break figures down by project. */
  readonly showProjects: boolean;
  /** Projects the workspaces tab picks between: the sidebar selection, or every project when nothing is selected. */
  readonly workspaceProjects: readonly StatsProjectGroup[];
  /** The one project (with all its local folders) the workspaces tab's claims and feedback show. */
  readonly workspaceProject: StatsProjectGroup | null;
  readonly ready: boolean;
  /** A row's project name; pass the row's daemon when it has one. */
  projectName(projectId: string, daemonId?: string | null): string;
  /** Rows from no daemon (unmerged) or the attached one live here, so their files and threads open locally. */
  isLocal(daemonId: string | null | undefined): boolean;
  /** The attached daemon's folder of a row's project, for actions that run here; null when this machine lacks it. */
  localProject(projectId: string, daemonId: string | null | undefined): string | null;
  /** The logical project another machine's row belongs to, for opening it by id; null for local rows. */
  remoteLogicalProject(projectId: string, daemonId: string | null | undefined): string | null;
  threadRoute(thread: StatsThreadLocation): WorkbenchRoute;
  openThread(event: MouseEvent<HTMLAnchorElement>, thread: StatsThreadLocation): void;
  setMode(mode: "selected" | "all"): void;
  setRange(range: WorkbenchStatsRange): void;
  pickPeriod(startedAt: number, extend: boolean): void;
  clearPeriod(): void;
  focusProject(project: StatsProjectLocation | null): void;
  setProvider(provider: WorkbenchHarness | null): void;
  setModel(provider: WorkbenchHarness, model: string | null): void;
  setTokenTypes(tokenTypes: StatsTokenType[]): void;
  setMetric(metric: StatsActivityMetric): void;
  setWorkspaceProject(id: string): void;
  addressFeedback(projectId: string, prompt: string): void;
}

interface Entry {
  readonly handle: WorkspaceQueryHandle<"stats">;
  readonly stop: () => void;
}

interface ReportEntry {
  readonly listeners: Set<() => void>;
  snapshot: StatsFeedbackReportSnapshot;
  stop: () => void;
}

const PENDING: StatsSectionSnapshot = { data: null, failure: null, loading: true, refining: false };
const REPORT_LOADING: StatsFeedbackReportSnapshot = { status: "loading" };
const reportKey = ({ feedbackId, threadId }: StatsFeedbackReport) => `${threadId}\0${feedbackId}`;

/** Owner first, then the narrowed feedback section: its report, an answer without it (deleted), or a failure. */
function reportSnapshot(
  feedbackId: number,
  owner: WorkspaceQuerySnapshot<"threadOwner">,
  section: WorkspaceQuerySnapshot<"stats"> | null,
): StatsFeedbackReportSnapshot {
  const ownerData = owner.value?.data;
  const ownerFailure = owner.failure ?? (ownerData && ownerData.phase !== "current" && ownerData.phase !== "pending" ? ownerData.failure : null);
  if (ownerFailure) return { status: "failed", failure: ownerFailure };
  const data = section?.value?.data;
  if (data?.section === "feedback") {
    const item = data.feedback.items.find(({ id }) => id === feedbackId);
    return item ? { status: "ready", item } : { status: "deleted" };
  }
  const failure = section?.failure ?? section?.value?.failure;
  return failure ? { status: "failed", failure } : REPORT_LOADING;
}

function sameReportSnapshot(left: StatsFeedbackReportSnapshot, right: StatsFeedbackReportSnapshot) {
  if (left.status !== right.status) return false;
  if (left.status === "ready" && right.status === "ready") return left.item === right.item;
  if (left.status === "failed" && right.status === "failed") return left.failure === right.failure;
  return true;
}
const EMPTY_SCOPE: StatsProjectScope = { attachedDaemonId: null, groups: [], labels: [], logical: new Map(), names: new Map(), references: [] };

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
    scope: EMPTY_SCOPE, projects: [], addressFeedback: () => {}, openRoute: () => {},
    threadRoute: () => { throw new Error("Stats threads cannot open before the view supplies routes."); },
  };
  readonly #workspace: WorkbenchWorkspaceClient | null;
  #state: StatsState;
  /** Leased feedback reports, each observed through its thread's owner. */
  readonly #reports = new Map<string, ReportEntry>();
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

  constructor(workspace: WorkbenchWorkspaceClient | null) {
    this.#workspace = workspace;
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
    // References are plain JSON in a fixed order, so their serialisation identifies the selection.
    const selection = (scope: StatsProjectScope) => `${scope.attachedDaemonId}\0${JSON.stringify(scope.references)}`;
    const changed = previous.projects !== inputs.projects
      || previous.scope.names !== inputs.scope.names || previous.scope.labels.join("\0") !== inputs.scope.labels.join("\0")
      || previous.threadRoute !== inputs.threadRoute || selection(previous.scope) !== selection(inputs.scope);
    if (!changed) return;
    // A changed sidebar selection replaces any project drilled into from the old one.
    if (selection(previous.scope) !== selection(inputs.scope)) this.#filters = { ...this.#filters, focusedProject: null };
    this.#update();
  }

  /** Release every observation; leased sections reopen on their next subscription. */
  dispose() {
    this.#closeEntries();
    for (const entry of this.#reports.values()) entry.stop();
    this.#reports.clear();
  }

  /**
   * The first lease observes the thread's owner, then the feedback section narrowed to the report on that thread's
   * folder, since report ids are only unique per daemon. The last release closes both observations.
   */
  subscribeFeedbackReport(report: StatsFeedbackReport, listener: () => void) {
    const key = reportKey(report);
    let entry = this.#reports.get(key);
    if (!entry) {
      const created: ReportEntry = { listeners: new Set(), snapshot: REPORT_LOADING, stop: () => {} };
      this.#reports.set(key, created);
      this.#observeReport(report, created);
      entry = created;
    }
    const leased = entry;
    leased.listeners.add(listener);
    return () => {
      leased.listeners.delete(listener);
      // Remounts (strict effects, windowed rows) re-lease before the microtask, so their observation survives.
      queueMicrotask(() => {
        if (leased.listeners.size || this.#reports.get(key) !== leased) return;
        this.#reports.delete(key);
        leased.stop();
      });
    };
  }

  getFeedbackReportSnapshot(report: StatsFeedbackReport): StatsFeedbackReportSnapshot {
    return this.#reports.get(reportKey(report))?.snapshot ?? REPORT_LOADING;
  }

  #observeReport(report: StatsFeedbackReport, entry: ReportEntry) {
    const workspace = this.#workspace;
    const threadId = ThreadReferenceSchema.safeParse(report.threadId).data;
    if (!workspace || !threadId) {
      entry.snapshot = { status: "failed", failure: workspace ? "The report's thread is unknown." : "The Workbench workspace is unavailable." };
      return;
    }
    const owner = workspace.observe({ kind: "threadOwner", threadId });
    let section: { readonly key: string; readonly handle: WorkspaceQueryHandle<"stats">; readonly stop: () => void } | null = null;
    const publish = () => {
      const next = reportSnapshot(report.feedbackId, owner.getSnapshot(), section?.handle.getSnapshot() ?? null);
      if (sameReportSnapshot(entry.snapshot, next)) return;
      entry.snapshot = next;
      for (const listener of [...entry.listeners]) listener();
    };
    const ownerChanged = () => {
      const data = owner.getSnapshot().value?.data;
      const location = data?.phase === "current" ? data.location : null;
      const key = location ? `${location.daemonId}/${location.projectId}` : null;
      if (section?.key !== key) {
        section?.stop();
        section = null;
        if (location && key) {
          const handle = workspace.observe({
            kind: "stats",
            projects: [{ kind: "location", location }],
            request: {
              feedbackId: report.feedbackId, model: null, period: null, provider: null,
              range: "7d", section: "feedback", tokenTypes: [...STATS_TOKEN_TYPES],
            },
          });
          const unsubscribe = handle.subscribe(publish);
          section = { key, handle, stop: () => { unsubscribe(); handle.release(); } };
        }
      }
      publish();
    };
    const unsubscribeOwner = owner.subscribe(ownerChanged);
    ownerChanged();
    entry.stop = () => {
      unsubscribeOwner();
      owner.release();
      section?.stop();
    };
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

  #references(): readonly WorkspaceProjectReference[] | null {
    const { focusedProject } = this.#filters;
    if (focusedProject) return [focusedProject.reference];
    return this.#mode() === "all" ? null : this.#inputs.scope.references;
  }

  #workspaceProjects(): readonly StatsProjectGroup[] {
    const { attachedDaemonId, groups } = this.#inputs.scope;
    if (groups.length) return groups;
    const daemonId = DaemonIdSchema.safeParse(attachedDaemonId).data;
    return daemonId ? this.#inputs.projects.map((project) => ({
      id: project.id, label: project.name, project,
      references: [{ kind: "location" as const, location: { daemonId, projectId: project.id } }],
    })) : [];
  }

  #logicalProject(projectId: string, daemonId: string | null | undefined) {
    const { attachedDaemonId, logical } = this.#inputs.scope;
    return logical.get(statsLocationKey(daemonId ?? attachedDaemonId, projectId)) ?? null;
  }

  /** A merged project row names its logical project; an unmerged one only its folder. */
  #focus(project: StatsProjectLocation): FocusedProject | null {
    const daemonId = project.daemonId ?? this.#inputs.scope.attachedDaemonId;
    const logicalId = LogicalProjectIdSchema.safeParse(project.logicalProjectId ?? this.#logicalProject(project.projectId, daemonId)).data;
    if (logicalId) return { key: logicalId, label: this.#state.projectName(logicalId), reference: { kind: "logical", projectId: logicalId } };
    const daemon = DaemonIdSchema.safeParse(daemonId).data;
    const physical = ProjectIdSchema.safeParse(project.projectId).data;
    return daemon && physical ? {
      key: statsLocationKey(daemon, physical), label: this.#state.projectName(physical, daemon),
      reference: { kind: "location", location: { daemonId: daemon, projectId: physical } },
    } : null;
  }

  /** A chosen project that left the selection falls back to the first one still selected. */
  #workspaceProject(): StatsProjectGroup | null {
    const projects = this.#workspaceProjects();
    return projects.find(({ id }) => id === this.#filters.workspaceProject) ?? projects[0] ?? null;
  }

  #mode(): "selected" | "all" {
    // The selection resolves after project facts load, so only an explicit choice overrides the default.
    return this.#filters.chosenMode ?? (this.#inputs.scope.references.length ? "selected" : "all");
  }

  #buildState(): StatsState {
    const filters = this.#filters;
    const inputs = this.#inputs;
    const references = this.#references();
    const { attachedDaemonId, names } = inputs.scope;
    const isLocal = (daemonId: string | null | undefined) => !daemonId || daemonId === attachedDaemonId;
    const projectName = (projectId: string, daemonId?: string | null) => names.get(statsLocationKey(daemonId ?? attachedDaemonId, projectId))
      ?? names.get(projectId) ?? inputs.projects.find(({ id }) => id === projectId)?.name ?? projectId;
    const remoteLogicalProject = (projectId: string, daemonId: string | null | undefined) =>
      isLocal(daemonId) ? null : this.#logicalProject(projectId, daemonId);
    const threadRoute = (thread: StatsThreadLocation) => inputs.threadRoute(thread, remoteLogicalProject(thread.projectId, thread.daemonId));
    return {
      focusedProject: filters.focusedProject,
      metric: filters.metric,
      mode: this.#mode(),
      model: filters.model,
      period: filters.period,
      references,
      projects: inputs.projects,
      provider: filters.provider,
      range: filters.range,
      ready: Boolean(this.#workspace),
      scope: inputs.scope,
      showProjects: references === null || references.length > 1 || references.some(({ kind }) => kind === "logical"),
      isLocal,
      localProject: (projectId, daemonId) => {
        if (isLocal(daemonId)) return projectId;
        const logicalId = this.#logicalProject(projectId, daemonId);
        if (!logicalId) return null;
        // The first of this machine's folders of the same project.
        for (const [key, owner] of inputs.scope.logical) {
          if (owner === logicalId && key.startsWith(`${attachedDaemonId}/`)) return key.slice(`${attachedDaemonId}/`.length);
        }
        return null;
      },
      remoteLogicalProject,
      threadRoute,
      openThread: (event, thread) => inputs.openRoute(event, threadRoute(thread)),
      tokenTypes: filters.tokenTypes,
      workspaceProject: this.#workspaceProject(),
      workspaceProjects: this.#workspaceProjects(),
      projectName,
      setMode: (chosenMode) => this.#setFilters({ chosenMode, focusedProject: null }),
      setRange: (range) => this.#setFilters({ range, period: null }),
      pickPeriod: (startedAt, extend) => this.#setFilters({ period: nextStatsPeriod(this.#filters.period, startedAt, extend) }),
      clearPeriod: () => this.#setFilters({ period: null }),
      focusProject: (project) => this.#setFilters({ focusedProject: project ? this.#focus(project) : null }),
      setProvider: (provider) => this.#setFilters({ provider, model: null }),
      setModel: (provider, model) => this.#setFilters({ model, provider: model ? provider : this.#filters.provider }),
      setTokenTypes: (tokenTypes) => this.#setFilters({ tokenTypes }),
      setMetric: (metric) => this.#setFilters({ metric }),
      setWorkspaceProject: (workspaceProject) => this.#setFilters({ workspaceProject }),
      addressFeedback: (projectId, prompt) => this.#inputs.addressFeedback(projectId, prompt),
    };
  }

  /** Provider, model and token types narrow usage only; activity, limits and status always span the whole range. */
  #request(name: StatsSectionName): StatsQuery | null {
    if (!this.#state.ready) return null;
    const filters = this.#filters;
    const usage = name === "usage" || name === "overview";
    const wholeRange = name === "overview" || name === "limits" || name === "status";
    // Contention and feedback read as one project's story, so the workspaces tab shows a single project.
    const workspace = name === "claims" || name === "feedback";
    const projects = workspace ? this.#workspaceProject()?.references ?? [] : this.#references();
    return {
      projects: projects === null ? null : [...projects],
      request: {
        feedbackId: null,
        model: usage ? filters.model : null,
        period: wholeRange || !filters.period ? null : { from: filters.period.from, to: filters.period.to },
        provider: usage ? filters.provider : null,
        range: filters.range,
        section: name === "overview" ? "usage" : name,
        tokenTypes: usage ? [...filters.tokenTypes] : [...STATS_TOKEN_TYPES],
      },
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
    const workspace = this.#workspace;
    const desired = new Map<string, StatsQuery>();
    this.#keys.clear();
    for (const [name, leases] of this.#leases) {
      if (!leases) continue;
      const query = this.#request(name);
      // Queries are plain JSON built in a fixed key order, so their serialisation is a stable identity.
      const key = query ? JSON.stringify(query) : null;
      this.#keys.set(name, key);
      if (key && query) desired.set(key, query);
    }
    for (const [key, entry] of this.#entries) {
      if (desired.has(key)) continue;
      entry.stop();
      this.#entries.delete(key);
    }
    if (workspace) {
      for (const [key, { projects, request }] of desired) {
        if (this.#entries.has(key)) continue;
        const handle = workspace.observe({ kind: "stats", projects, request });
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
