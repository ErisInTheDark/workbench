"use client";

/*
 * Exports:
 * - default WorkbenchStatsControls: the scope, range and filter row every stats tab shares, with the view's status slot.
 */
import type { ReactNode } from "react";
import type { WorkbenchStatsTab } from "workbench-shared/workbench/navigation/workbench-route";
import type { WorkbenchStatsRange } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchModeRow from "../WorkbenchModeRow";
import WorkbenchProjectControl from "../WorkbenchProjectControl";
import useStats from "./use-stats";
import WorkbenchStatsStatus from "./WorkbenchStatsStatus";
import { formatStatsBucket, providerLabel } from "./stats-formatters";

const RANGES: ReadonlyArray<{ label: string; title: string; value: WorkbenchStatsRange }> = [
  { label: "7d", title: "Last 7 days", value: "7d" },
  { label: "2w", title: "Last 2 weeks", value: "14d" },
  { label: "30d", title: "Last 30 days", value: "30d" },
  { label: "90d", title: "Last 90 days", value: "90d" },
  { label: "1y", title: "Last year, by week", value: "365d" },
];

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

export default function WorkbenchStatsControls({ error, tab }: { error: string; tab: WorkbenchStatsTab }) {
  const stats = useStats();
  const { focusedProject, mode, model, period, provider, range, scope } = stats;
  const unit = range === "365d" ? "week" : "day";
  const selectedLabel = scope.labels.length === 1 ? scope.labels[0]! : `${scope.labels.length} projects`;
  const periodLabel = period
    ? `${formatStatsBucket(period.from, unit)}${period.to === period.from ? "" : ` – ${formatStatsBucket(period.to, unit)}`}`
    : null;
  // Provider and model narrow usage only, so their chips live where they apply.
  const usageFilters = tab === "usage";
  const workspaces = tab === "workspaces";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {workspaces ? (
          stats.workspaceProject?.project ? (
            <WorkbenchProjectControl
              action="Show contention and feedback for"
              onSelect={stats.setWorkspaceProject}
              project={stats.workspaceProject.project}
              projects={stats.workspaceProjects.flatMap(({ project }) => project ? [project] : [])}
            />
          ) : null
        ) : (
          <WorkbenchModeRow
            ariaLabel="Projects included"
            onChange={stats.setMode}
            options={[
              {
                disabled: !scope.references.length, label: `Selected · ${selectedLabel}`,
                title: scope.labels.join(", ") || "No selected projects", value: "selected",
              },
              { label: "All projects", title: "Every project on every machine", value: "all" },
            ]}
            value={mode}
          />
        )}
        <WorkbenchModeRow
          ariaLabel="Statistics range"
          onChange={stats.setRange}
          options={RANGES.map(({ label, title, value }) => ({ ariaLabel: title, label, title, value }))}
          value={range}
        />
        <div aria-label="Active filters" className="flex min-h-6 flex-wrap items-center gap-1.5" role="group">
          {periodLabel ? <FilterChip onClear={stats.clearPeriod}>Period: {periodLabel}</FilterChip> : null}
          {!workspaces && focusedProject ? <FilterChip onClear={() => stats.focusProject(null)}>Project: {focusedProject.label}</FilterChip> : null}
          {usageFilters && provider ? <FilterChip onClear={() => stats.setProvider(null)}>Provider: {providerLabel(provider)}</FilterChip> : null}
          {usageFilters && model && provider ? <FilterChip onClear={() => stats.setModel(provider, null)}>Model: {model}</FilterChip> : null}
        </div>
        <WorkbenchStatsStatus error={error} />
      </div>
    </div>
  );
}
