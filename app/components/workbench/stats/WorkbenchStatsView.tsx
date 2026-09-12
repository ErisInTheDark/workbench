"use client";

/*
 * Keywords: stats, usage, input cache, claims, rate limits.
 * Exports:
 * - default WorkbenchStatsView: compose stats controls, import state, usage, limits, and claim traffic. Keywords: stats, usage, claims, rate limits.
 */
import {
  useContext,
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
} from "workbench-shared/workbench/stats/workbench-stats-contract";
import { STATS_TOKEN_TYPES, hasStatsCategoryCosts, type StatsTokenType, type WorkbenchStatsDetailedReadRequest } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import WorkbenchStatsLoadController from "../../../workbench/WorkbenchStatsLoadController";
import WorkbenchStatsClient from "../../../workbench/WorkbenchStatsClient";
import WorkbenchDaemonClientContext from "../WorkbenchDaemonClientContext";
import WorkbenchClaimHotspots from "./WorkbenchClaimHotspots";
import WorkbenchCacheEfficiency from "./WorkbenchCacheEfficiency";
import WorkbenchCostUsage from "./WorkbenchCostUsage";
import WorkbenchRateLimitUsage from "./WorkbenchRateLimitUsage";
import WorkbenchStatsFilters from "./WorkbenchStatsFilters";
import WorkbenchStatsSummary from "./WorkbenchStatsSummary";
import WorkbenchTokenUsage from "./WorkbenchTokenUsage";
import WorkbenchUsageDrivers from "./WorkbenchUsageDrivers";
import WorkbenchTokenTypeControls from "./WorkbenchTokenTypeControls";
import WorkbenchStatsStatus from "./WorkbenchStatsStatus";
import WorkbenchTab from "../WorkbenchTab";

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
  projects: readonly Pick<WorkbenchProjectOption, "id" | "name" | "kind" | "roots">[];
}) {
  const daemon = useContext(WorkbenchDaemonClientContext);
  const client = useMemo(() => daemon ? new WorkbenchStatsClient(daemon) : null, [daemon]);
  const clientRef = useRef(client);
  clientRef.current = client;
  const controller = useMemo(
    () => new WorkbenchStatsLoadController((request) => {
      if (!clientRef.current) throw new Error("Statistics are waiting for the daemon connection.");
      return clientRef.current.read(request);
    }),
    [],
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [range, setRange] = useState<WorkbenchStatsRange>("7d");
  const [provider, setProvider] = useState<WorkbenchHarness | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [tokenTypes, setTokenTypes] = useState<StatsTokenType[]>([...STATS_TOKEN_TYPES]);
  const [actionError, setActionError] = useState("");
  const [importProgress, setImportProgress] = useState<WorkbenchStatsImportProgress | null>(null);
  const request = useMemo<WorkbenchStatsDetailedReadRequest>(
    () => ({ model, projectId, provider, range, tokenTypes }),
    [model, projectId, provider, range, tokenTypes],
  );
  const projectNamesById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (!client) return;
    void controller.load(request);
  }, [client, controller, request]);

  useEffect(() => {
    if (!daemon || !client) return;
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
      void controller.refresh();
    });
    const unsubscribeReconnect = daemon.onReconnect(() => {
      client.reconnected();
      void controller.refresh();
      void start();
    });
    void start();
    return () => {
      active = false;
      unsubscribeProgress();
      unsubscribeReconnect();
    };
  }, [client, controller, daemon]);

  const stats = snapshot.stats;
  const legacy = Boolean(stats && !hasStatsCategoryCosts(stats));
  const shownTypes = legacy ? STATS_TOKEN_TYPES : snapshot.displayedRequest?.tokenTypes ?? STATS_TOKEN_TYPES;
  const visibleError = actionError || snapshot.error;
  return (
    <div className="mx-auto flex w-full max-w-[72rem] flex-col gap-5 py-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="m-0 text-[0.8rem] font-medium tracking-[0.08em] text-fg/muted uppercase">Recent usage</p>
          <h1 className="m-0 text-[1.65rem] font-semibold leading-tight text-text">Statistics</h1>
        </div>
          <div aria-label="Statistics scope" className="flex max-w-full items-end gap-4 text-[0.9rem]" role="tablist">
            <WorkbenchTab
              selected={projectId === null}
              href={createStatsHref(null)}
              onClick={(event) => onNavigate(event, null)}
            >
              Global
            </WorkbenchTab>
            {availableProjectId ? (
              <WorkbenchTab
                selected={projectId !== null}
                href={createStatsHref(availableProjectId)}
                onClick={(event) => onNavigate(event, availableProjectId)}
              >
                {projectLabel}
              </WorkbenchTab>
            ) : null}
          </div>
      </header>

      <div className="flex flex-col gap-2">
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

      <WorkbenchTokenTypeControls selected={tokenTypes} onChange={setTokenTypes} disabled={!stats || legacy} />
      <WorkbenchStatsStatus
        ready={Boolean(daemon)} loading={snapshot.loading} retained={Boolean(stats)}
        error={visibleError} progress={importProgress ?? stats?.historyImport ?? null}
        failures={stats?.failures ?? []} legacy={legacy}
      />
      </div>
      <div aria-busy={snapshot.loading} className="flex flex-col gap-6">
          <WorkbenchStatsSummary stats={stats} />
          <section aria-label="Token and cost usage" className="grid gap-6 lg:grid-cols-2">
            <WorkbenchTokenUsage stats={stats} selected={shownTypes} />
            <WorkbenchCostUsage stats={stats} selected={shownTypes} />
          </section>
          <WorkbenchCacheEfficiency
            global={projectId === null}
            onNavigateThread={onNavigateThread}
            projectNamesById={projectNamesById}
            stats={stats}
          />
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
            projects={projects}
          />
      </div>
    </div>
  );
}
