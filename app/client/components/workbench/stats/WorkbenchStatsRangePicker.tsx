/*
 * Exports:
 * - default WorkbenchStatsRangePicker: the statistics window toggle, beside the project toggle.
 */
import type { WorkbenchStatsRange } from "workbench-shared/workbench/stats/workbench-stats-contract";
import WorkbenchModeRow from "../WorkbenchModeRow";

const RANGES: ReadonlyArray<{ label: string; title: string; value: WorkbenchStatsRange }> = [
  { label: "7d", title: "Last 7 days", value: "7d" },
  { label: "2w", title: "Last 2 weeks", value: "14d" },
  { label: "30d", title: "Last 30 days", value: "30d" },
  { label: "90d", title: "Last 90 days", value: "90d" },
  { label: "1y", title: "Last year, by week", value: "365d" },
];

export default function WorkbenchStatsRangePicker({ onChange, range }: {
  onChange: (range: WorkbenchStatsRange) => void;
  range: WorkbenchStatsRange;
}) {
  return (
    <WorkbenchModeRow
      ariaLabel="Statistics range"
      onChange={onChange}
      options={RANGES.map(({ label, title, value }) => ({ ariaLabel: title, label, title, value }))}
      value={range}
    />
  );
}
