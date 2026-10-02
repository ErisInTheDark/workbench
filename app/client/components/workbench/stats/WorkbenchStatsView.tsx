"use client";

/*
 * Exports:
 * - default WorkbenchStatsView: own the statistics scope, range, period, filters, and observations, and compose the usage, limit, cache, and claim panels.
 */
import {
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { WorkbenchHarness, WorkbenchProjectOption } from "workbench-shared/types";
import { DaemonIdSchema } from "workbench-shared/workbench/identity";
import {
  STATS_TOKEN_TYPES,
  type StatsTokenType,
  type WorkbenchStatsRange,
  type WorkbenchStatsReadRequestSchema,
  type WorkbenchStatsResponse,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import type { WorkspaceQuery } from "workbench-shared/workbench/workspace/workspace-observation";
import type { z } from "zod";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";
import type WorkbenchWorkspaceClient from "../../../workbench/app/WorkbenchWorkspaceClient";
import WorkbenchModeRow from "../WorkbenchModeRow";
import WorkbenchWorkspaceContext, { WorkbenchOperationsContext as WorkbenchDaemonClientContext } from "../WorkbenchWorkspaceContext";
import WorkbenchCacheEfficiency from "./WorkbenchCacheEfficiency";
import WorkbenchClaimHotspots from "./WorkbenchClaimHotspots";
import WorkbenchStatsActivity, { type StatsActivityMetric } from "./WorkbenchStatsActivity";
import WorkbenchStatsBreakdowns from "./WorkbenchStatsBreakdowns";
import WorkbenchStatsHeadline from "./WorkbenchStatsHeadline";
import WorkbenchStatsLimits from "./WorkbenchStatsLimits";
import WorkbenchStatsRangePicker from "./WorkbenchStatsRangePicker";
import WorkbenchStatsStatus from "./WorkbenchStatsStatus";
import { formatStatsBucket, providerLabel } from "./stats-formatters";
import { statsModelHues } from "./stats-model-colours";
import { nextStatsPeriod, type StatsPeriodSelection } from "./stats-period";
import type { StatsProjectScope } from "./stats-project-scope";

function FilterChip({ children, onClear }: { children: ReactNode; onClear: () => void }) {
  return (
    <button
      className="group inline-flex max-w-64 items-center gap-1.5 rounded-full bg-fg/7 py-0.5 pl-2.5 pr-1.5 text-[0.74rem] font-medium text-text hover:bg-fg/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={onClear}
      title="Remove filter"
      type="button"
    >
      <span className="truncate">{children}</span>
      <span aria-hidden="true" className="text-fg/muted group-hover:text-text">×</span>
      <span className="sr-only">Remove filter</span>
    </button>
  );
}

type StatsQuery = Extract<WorkspaceQuery, { kind: "stats" }>;

/** A new query starts empty, so the previous figures stay on screen, dimmed, until it publishes. */
function useStatsObservation(workspace: WorkbenchWorkspaceClient | null, query: StatsQuery | null) {
  const observation = useWorkspaceObservation(workspace, query);
  const observed = observation.value?.data ?? null;
  const [retained, setRetained] = useState<WorkbenchStatsResponse | null>(null);
  if (observed && observed !== retained) setRetained(observed);
  if (!query && retained) setRetained(null);
  return {
    claimsPending: !observed || observation.value?.claimsPhase === "pending",
    failure: observation.failure,
    loading: !observed,
    stats: observed ?? retained,
  };
}

export default function WorkbenchStatsView({ onNavigateThread, projects, scope }: {
  onNavigateThread: (event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string) => void;
  projects: readonly Pick<WorkbenchProjectOption, "id" | "name" | "kind" | "roots">[];
  /** The sidebar selection, resolved onto this daemon's projects. */
  scope: StatsProjectScope;
}) {
  const daemon = useContext(WorkbenchDaemonClientContext);
  const workspace = useContext(WorkbenchWorkspaceContext);
  const hasSelection = scope.projectIds.length > 0 || scope.elsewhere.length > 0;
  // The selection resolves after project facts load, so only an explicit choice overrides the default.
  const [chosenMode, setMode] = useState<"selected" | "all" | null>(null);
  const mode = chosenMode ?? (hasSelection && scope.projectIds.length ? "selected" : "all");
  const [range, setRange] = useState<WorkbenchStatsRange>("7d");
  const [period, setPeriod] = useState<StatsPeriodSelection | null>(null);
  const [focusedProject, setFocusedProject] = useState<string | null>(null);
  const [provider, setProvider] = useState<WorkbenchHarness | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [tokenTypes, setTokenTypes] = useState<StatsTokenType[]>([...STATS_TOKEN_TYPES]);
  const [metric, setMetric] = useState<StatsActivityMetric>("cost");
  const [actionError, setActionError] = useState("");
  // The selection array is rebuilt every render; its joined key is the stable identity.
  const selectionKey = scope.projectIds.join("\0");
  const request = useMemo<z.output<typeof WorkbenchStatsReadRequestSchema>>(() => ({
    model, period: null, provider, range, tokenTypes,
    projectIds: focusedProject ? [focusedProject] : mode === "all" ? null : selectionKey ? selectionKey.split("\0") : [],
  }), [focusedProject, mode, model, provider, range, selectionKey, tokenTypes]);
  const projectIds = request.projectIds;
  const projectName = (projectId: string) => scope.names.get(projectId) ?? projects.find(({ id }) => id === projectId)?.name ?? projectId;
  const daemonId = DaemonIdSchema.safeParse(scope.daemonId).data ?? null;
  // Activity and plan limits always read the whole range; a picked period narrows everything else.
  const overview = useStatsObservation(workspace, useMemo(
    () => daemonId ? { kind: "stats" as const, daemonId, request } : null,
    [daemonId, request],
  ));
  const narrowed = useStatsObservation(workspace, useMemo(
    () => daemonId && period ? { kind: "stats" as const, daemonId, request: { ...request, period: { from: period.from, to: period.to } } } : null,
    [daemonId, period, request],
  ));
  const detail = period ? { ...narrowed, stats: narrowed.stats ?? overview.stats } : overview;
  const stats = overview.stats;
  const unit = stats?.bucketUnit ?? "day";

  // A changed sidebar selection replaces any project drilled into from the old one.
  useEffect(() => { setFocusedProject(null); }, [selectionKey]);

  // Commands only nudge the daemon; their effects stream back through the observation.
  useEffect(() => {
    if (!daemon) return;
    let active = true;
    const report = (error: unknown, fallback: string) => {
      if (active) setActionError(error instanceof Error ? error.message : fallback);
    };
    const start = () => daemon.stats.startImport()
      .then(() => { if (active) setActionError(""); })
      .catch((error: unknown) => report(error, "Unable to start history import."));
    const unsubscribeReconnect = daemon.onReconnect(() => { void start(); });
    void start();
    void daemon.stats.refreshRateLimits().catch((error: unknown) => report(error, "Unable to refresh plan limits."));
    return () => {
      active = false;
      unsubscribeReconnect();
    };
  }, [daemon]);

  // Every model in the window, so narrowing to one model never repaints the others.
  const modelHues = useMemo(() => statsModelHues(stats?.usageFilters.models ?? []), [stats?.usageFilters.models]);
  const showProjects = projectIds === null || projectIds.length > 1;
  const selectedLabel = scope.labels.length === 1 ? scope.labels[0]! : `${scope.labels.length} projects`;
  const periodLabel = period
    ? `${formatStatsBucket(period.from, unit)}${period.to === period.from ? "" : ` – ${formatStatsBucket(period.to, unit)}`}`
    : null;
  const dim = (loading: boolean) => loading && stats ? "opacity-70" : "";

  return (
    <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-7 pb-10 pt-1">
      {/* Limits sit above the scope controls because they are account-wide and ignore them. */}
      <header className="flex flex-col gap-5">
        <WorkbenchStatsLimits now={stats?.generatedAt ?? 0} stats={stats} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <WorkbenchModeRow
            ariaLabel="Projects included"
            onChange={(value) => { setFocusedProject(null); setMode(value); }}
            options={[
              {
                disabled: !scope.projectIds.length, label: `Selected · ${selectedLabel}`,
                title: scope.labels.join(", ") || "No selected projects on this machine", value: "selected",
              },
              { label: "All projects", title: "Every project on this machine", value: "all" },
            ]}
            value={mode}
          />
          <WorkbenchStatsRangePicker onChange={(next) => { setRange(next); setPeriod(null); }} range={range} />
          <div aria-label="Active filters" className="flex min-h-6 flex-wrap items-center gap-1.5" role="group">
            {periodLabel ? <FilterChip onClear={() => setPeriod(null)}>Period: {periodLabel}</FilterChip> : null}
            {focusedProject ? <FilterChip onClear={() => setFocusedProject(null)}>Project: {projectName(focusedProject)}</FilterChip> : null}
            {provider ? <FilterChip onClear={() => { setProvider(null); setModel(null); }}>Provider: {providerLabel(provider)}</FilterChip> : null}
            {model ? <FilterChip onClear={() => setModel(null)}>Model: {model}</FilterChip> : null}
          </div>
          <WorkbenchStatsStatus
            error={actionError || overview.failure || narrowed.failure || ""}
            failures={stats?.failures ?? []}
            loading={overview.loading || detail.loading}
            progress={stats?.historyImport ?? null}
            ready={Boolean(daemonId && workspace)}
            retained={Boolean(stats)}
          />
        </div>
        {mode === "selected" && !focusedProject && scope.elsewhere.length ? (
          <p className="m-0 -mt-3 text-[0.74rem] text-fg/muted">
            {scope.elsewhere.join(", ")} {scope.elsewhere.length === 1 ? "lives" : "live"} on another machine and {scope.elsewhere.length === 1 ? "is" : "are"} not counted here.
          </p>
        ) : null}
      </header>

      <div aria-busy={detail.loading} className={`transition-opacity ${dim(detail.loading)}`}>
        <WorkbenchStatsHeadline stats={detail.stats} />
      </div>
      <div aria-busy={overview.loading} className={`pt-3 transition-opacity ${dim(overview.loading)}`}>
        <WorkbenchStatsActivity
          metric={metric}
          onMetricChange={setMetric}
          onPeriodPick={(startedAt, extend) => setPeriod((current) => nextStatsPeriod(current, startedAt, extend))}
          onTokenTypesChange={setTokenTypes}
          period={period}
          stats={stats}
          tokenTypes={tokenTypes}
        />
      </div>
      <div aria-busy={detail.loading} className={`flex flex-col gap-10 pt-3 transition-opacity ${dim(detail.loading)}`}>
        <WorkbenchStatsBreakdowns
          metric={metric}
          model={model}
          modelHues={modelHues}
          onModelChange={(nextProvider, nextModel) => { setProvider(nextModel ? nextProvider : provider); setModel(nextModel); }}
          onNavigateThread={onNavigateThread}
          onProviderChange={(nextProvider) => { setProvider(nextProvider); setModel(null); }}
          {...(showProjects ? { onSelectProject: setFocusedProject } : {})}
          projectName={projectName}
          provider={provider}
          showProjects={showProjects}
          stats={detail.stats}
        />
        <WorkbenchCacheEfficiency onNavigateThread={onNavigateThread} projectName={projectName} showProjects={showProjects} stats={detail.stats} />
        <WorkbenchClaimHotspots
          pending={detail.claimsPending}
          projectName={projectName}
          projects={projects}
          showProjects={showProjects}
          stats={detail.stats}
        />
      </div>
    </div>
  );
}
