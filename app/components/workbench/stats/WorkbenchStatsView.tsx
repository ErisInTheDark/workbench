"use client";

/*
 * Exports:
 * - default WorkbenchStatsView: compose stats controls, import state, usage, limits, and claim traffic. Keywords: stats, usage, claims, rate limits.
 * Local helpers: render compact split import progress. Keywords: stats, import, progress.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";

import type { WorkbenchHarness, WorkbenchProjectOption } from "workbench-shared/types";
import { createStatsHref } from "workbench-shared/workbench/navigation/workbench-route";
import type {
  WorkbenchStatsImportProgress,
  WorkbenchStatsRange,
  WorkbenchStatsReadRequest,
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchStatsLoadController from "../../../workbench/WorkbenchStatsLoadController";
import { useWorkbenchDaemonClient } from "../WorkbenchDaemonClientContext";
import WorkbenchClaimHotspots from "./WorkbenchClaimHotspots";
import WorkbenchCostUsage from "./WorkbenchCostUsage";
import WorkbenchRateLimitUsage from "./WorkbenchRateLimitUsage";
import WorkbenchStatsFilters from "./WorkbenchStatsFilters";
import WorkbenchStatsSummary from "./WorkbenchStatsSummary";
import WorkbenchTokenUsage from "./WorkbenchTokenUsage";
import WorkbenchUsageDrivers from "./WorkbenchUsageDrivers";

function ImportProgress({ progress }: { progress: WorkbenchStatsImportProgress }) {
  const hasDetails = progress.recentFailures.length > 0;
  if (progress.state !== "running" && !hasDetails) return null;
  return (
    <div className="space-y-1 text-[0.72rem] text-muted">
      {progress.state === "running" ? (
        <p className="m-0">
          Importing history · {progress.percent.toFixed(0)}%
          {" · "}usage {progress.usage.processed}/{progress.usage.total}
          {" · "}claims {progress.claims.processed}/{progress.claims.total}
          {progress.unsupportedClaimCheckpoints ? ` · ${progress.unsupportedClaimCheckpoints} older claim checkpoints unsupported` : ""}
        </p>
      ) : null}
      {hasDetails ? (
        <details>
          <summary className="w-fit cursor-pointer rounded-md px-1 py-0.5 text-danger hover:bg-surface-hover">
            {progress.recentFailures.length} import {progress.recentFailures.length === 1 ? "failure" : "failures"}
          </summary>
          <ul className="m-0 mt-1 space-y-1 p-0">
            {progress.recentFailures.map((failure) => (
              <li className="list-none" key={`${failure.source}:${failure.subject}`}>
                {failure.source} · {failure.subject} · {failure.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export default function WorkbenchStatsView({
  availableProjectId,
  onNavigate,
  onNavigateThread,
  projectId,
  projectLabel,
  projects,
}: {
  availableProjectId: string | null;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, projectId: string | null) => void;
  onNavigateThread: (event: MouseEvent<HTMLAnchorElement>, projectId: string, threadId: string) => void;
  projectId: string | null;
  projectLabel: string;
  projects: readonly Pick<WorkbenchProjectOption, "id" | "name">[];
}) {
  const daemon = useWorkbenchDaemonClient();
  const controller = useMemo(
    () => new WorkbenchStatsLoadController((request) => daemon.request("stats/read", request)),
    [daemon],
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [range, setRange] = useState<WorkbenchStatsRange>("7d");
  const [provider, setProvider] = useState<WorkbenchHarness | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [importProgress, setImportProgress] = useState<WorkbenchStatsImportProgress | null>(null);
  const request = useMemo<WorkbenchStatsReadRequest>(
    () => ({ model, projectId, provider, range }),
    [model, projectId, provider, range],
  );
  const requestRef = useRef(request);
  requestRef.current = request;
  const projectNamesById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    void controller.load(request);
  }, [controller, request]);

  useEffect(() => {
    let active = true;
    const start = async () => {
      try {
        const progress = await daemon.request("stats/import/start", {});
        if (active) {
          setActionError("");
          setImportProgress(progress);
        }
      } catch (error) {
        if (active) setActionError(error instanceof Error ? error.message : "Unable to start history import.");
      }
    };
    const unsubscribeProgress = daemon.onStatsImportProgress((progress) => {
      if (!active) return;
      setImportProgress(progress);
      void controller.refresh(requestRef.current);
    });
    const unsubscribeReconnect = daemon.onReconnect(() => { void start(); });
    void start();
    return () => {
      active = false;
      unsubscribeProgress();
      unsubscribeReconnect();
    };
  }, [controller, daemon]);

  useEffect(() => {
    if (provider && snapshot.stats && !snapshot.stats.usageFilters.providers.includes(provider)) {
      setProvider(null);
      setModel(null);
    } else if (model && snapshot.stats && !snapshot.stats.usageFilters.models.includes(model)) {
      setModel(null);
    }
  }, [model, provider, snapshot.stats]);

  const refreshLimits = useCallback(async () => {
    setRefreshing(true);
    setActionError("");
    try {
      await daemon.request("stats/rate-limits/refresh", {});
      await controller.refresh(requestRef.current);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to refresh rate limits.");
    } finally {
      setRefreshing(false);
    }
  }, [controller, daemon]);

  const stats = snapshot.stats;
  const visibleError = actionError || snapshot.error;
  return (
    <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-8 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-muted uppercase">Recent usage</p>
          <h1 className="m-0 text-[1.65rem] font-semibold leading-tight text-text">Statistics</h1>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div aria-label="Statistics scope" className="flex items-end gap-4" role="tablist">
            <a
              aria-selected={projectId === null}
              className={`border-b-2 pb-1 text-[0.9rem] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft${projectId === null ? " border-text text-text" : " border-transparent text-muted hover:text-text"}`}
              href={createStatsHref(null)}
              onClick={(event) => onNavigate(event, null)}
              role="tab"
            >
              Global
            </a>
            {availableProjectId ? (
              <a
                aria-selected={projectId !== null}
                className={`max-w-[12rem] truncate border-b-2 pb-1 text-[0.9rem] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft${projectId !== null ? " border-text text-text" : " border-transparent text-muted hover:text-text"}`}
                href={createStatsHref(availableProjectId)}
                onClick={(event) => onNavigate(event, availableProjectId)}
                role="tab"
              >
                {projectLabel}
              </a>
            ) : null}
          </div>
          <button
            className="rounded-md px-2 py-1 text-[0.8rem] font-medium text-muted transition hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
            disabled={refreshing}
            onClick={() => { void refreshLimits(); }}
            type="button"
          >
            {refreshing ? "Refreshing..." : "Refresh limits"}
          </button>
        </div>
      </header>

      <WorkbenchStatsFilters
        model={model}
        models={stats?.usageFilters.models ?? []}
        onModelChange={setModel}
        onProviderChange={(nextProvider) => {
          setProvider(nextProvider);
          setModel(null);
        }}
        onRangeChange={setRange}
        provider={provider}
        providers={stats?.usageFilters.providers ?? []}
        range={range}
      />

      {importProgress ? <ImportProgress progress={importProgress} /> : null}
      {visibleError ? <p className="m-0 text-[0.82rem] text-danger">{visibleError}</p> : null}
      {snapshot.loading && !stats ? <p className="m-0 py-12 text-center text-[0.9rem] text-muted">Loading usage...</p> : null}
      {stats ? (
        <>
          <WorkbenchStatsSummary stats={stats} />
          <section aria-label="Token and cost usage" className="grid gap-10 lg:grid-cols-2">
            <WorkbenchTokenUsage stats={stats} />
            <WorkbenchCostUsage stats={stats} />
          </section>
          <WorkbenchUsageDrivers
            global={projectId === null}
            onNavigateThread={onNavigateThread}
            projectNamesById={projectNamesById}
            stats={stats}
          />
          <WorkbenchRateLimitUsage stats={stats} />
          <WorkbenchClaimHotspots
            global={projectId === null}
            projectNamesById={projectNamesById}
            stats={stats}
          />
          {stats.failures.length ? (
            <details className="text-[0.72rem] leading-5 text-muted">
              <summary className="w-fit cursor-pointer rounded-md px-1 py-0.5 text-danger hover:bg-surface-hover">
                {stats.failures.length} capture {stats.failures.length === 1 ? "issue" : "issues"}
              </summary>
              <ul className="m-0 mt-2 space-y-1 p-0">
                {stats.failures.map((failure, index) => (
                  <li className="list-none" key={`${failure.source}:${failure.harness}:${index}`}>
                    {failure.harness ? `${failure.harness} · ` : ""}{failure.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
