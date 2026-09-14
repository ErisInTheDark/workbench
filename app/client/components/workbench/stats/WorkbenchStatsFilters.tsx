/*
 * Exports:
 * - default WorkbenchStatsFilters: render range controls and rotating provider/model usage filters. Keywords: stats, filters, range.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import type { WorkbenchStatsRange } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { providerLabel } from "./stats-formatters";
import WorkbenchRotatorButton from "../WorkbenchRotatorButton";
import WorkbenchTab from "../WorkbenchTab";

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
      <div aria-label="Statistics range" className="flex flex-wrap items-end gap-4 text-[0.78rem]" role="tablist">
        {RANGES.map((candidate) => (
          <WorkbenchTab
            selected={range === candidate.value}
            key={candidate.value}
            onClick={() => onRangeChange(candidate.value)}
          >
            {candidate.label}
          </WorkbenchTab>
        ))}
      </div>
      <div aria-label="Usage filters" className="flex flex-wrap items-center gap-2 text-[0.78rem]" role="group">
        <WorkbenchRotatorButton
          ariaLabel="Rotate provider filter"
          onRotate={() => onProviderChange(nextValue(provider, providers))}
          title="Show the next provider"
        >
          {provider ? providerLabel(provider) : "All providers"}
        </WorkbenchRotatorButton>
        <WorkbenchRotatorButton
          ariaLabel="Rotate model filter"
          disabled={!models.length && !model}
          onRotate={() => onModelChange(nextValue(model, models))}
          title={model ?? "Show the next model"}
        >
          <span className="truncate">{model ?? "All models"}</span>
        </WorkbenchRotatorButton>
      </div>
    </div>
  );
}
