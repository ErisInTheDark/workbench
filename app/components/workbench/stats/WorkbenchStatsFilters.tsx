/*
 * Exports:
 * - default WorkbenchStatsFilters: render range controls and rotating provider/model usage filters. Keywords: stats, filters, range.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStatsRange } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { providerLabel } from "./stats-formatters";

const RANGES: ReadonlyArray<{ label: string; value: WorkbenchStatsRange }> = [
  { label: "7 days", value: "7d" },
  { label: "2 weeks", value: "14d" },
  { label: "1 month", value: "30d" },
  { label: "3 months", value: "90d" },
  { label: "1 year", value: "365d" },
];

function nextValue<T>(current: T | null, values: readonly T[]) {
  const choices: Array<T | null> = [null, ...values, ...(current !== null && !values.includes(current) ? [current] : [])];
  return choices[(choices.indexOf(current) + 1) % choices.length] ?? null;
}

export default function WorkbenchStatsFilters({
  model,
  models,
  onModelChange,
  onProviderChange,
  onRangeChange,
  provider,
  providers,
  range,
}: {
  model: string | null;
  models: readonly string[];
  onModelChange: (model: string | null) => void;
  onProviderChange: (provider: WorkbenchHarness | null) => void;
  onRangeChange: (range: WorkbenchStatsRange) => void;
  provider: WorkbenchHarness | null;
  providers: readonly WorkbenchHarness[];
  range: WorkbenchStatsRange;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div aria-label="Statistics range" className="flex flex-wrap gap-1" role="group">
        {RANGES.map((candidate) => (
          <button
            aria-pressed={range === candidate.value}
            className={`rounded-md px-2.5 py-1.5 text-[0.78rem] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft${range === candidate.value ? " bg-surface-hover text-text" : " text-muted hover:bg-surface-hover hover:text-text"}`}
            key={candidate.value}
            onClick={() => onRangeChange(candidate.value)}
            type="button"
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div aria-label="Usage filters" className="flex flex-wrap items-center gap-2" role="group">
        <span className="text-[0.7rem] font-medium tracking-[0.08em] text-muted uppercase">Usage filters</span>
        <button
          aria-label="Rotate provider filter"
          className="w-32 truncate rounded-md px-2 py-1 text-[0.78rem] font-medium text-muted transition hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
          onClick={() => onProviderChange(nextValue(provider, providers))}
          title="Show the next provider"
          type="button"
        >
          {provider ? providerLabel(provider) : "All providers"}
        </button>
        <button
          aria-label="Rotate model filter"
          className="w-44 max-w-full truncate rounded-md px-2 py-1 text-[0.78rem] font-medium text-muted transition hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-50"
          disabled={!models.length && !model}
          onClick={() => onModelChange(nextValue(model, models))}
          title="Show the next model"
          type="button"
        >
          {model ?? "All models"}
        </button>
      </div>
    </div>
  );
}
