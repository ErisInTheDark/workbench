/*
 * Keywords: stats, token selection, shared checkbox.
 * Exports:
 * - default WorkbenchTokenTypeControls: controlled global usage-category selection.
 */
import { STATS_TOKEN_TYPES, type StatsTokenType } from "workbench-shared/workbench/stats/workbench-stats-detail-contract";
import WorkbenchCheckbox from "../WorkbenchCheckbox";
import { STATS_TOKEN_SERIES } from "./stats-token-series";

export default function WorkbenchTokenTypeControls ({ selected, onChange, disabled }: {
  selected: readonly StatsTokenType[];
  onChange: (selected: StatsTokenType[]) => void;
  disabled: boolean;
}) {
  return (
    <div aria-label="Token types" className="flex min-h-9 flex-wrap items-center gap-2" role="group">
      {STATS_TOKEN_SERIES.map(({ key, label, colourClassName, Icon }) => (
        <WorkbenchCheckbox
          checked={selected.includes(key)}
          disabled={disabled}
          key={key}
          label={<span className={`inline-flex items-center gap-1.5 align-middle font-bold [--hue-chroma:50%] ${colourClassName}`}><Icon className="block size-4 shrink-0" />{label}</span>}
          onChange={(checked) => onChange(STATS_TOKEN_TYPES.filter((type) => type === key ? checked : selected.includes(type)))}
        />
      ))}
    </div>
  );
}
