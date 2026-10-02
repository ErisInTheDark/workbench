/*
 * Exports:
 * - StatsShareRow: one ranked row with its share of the largest row.
 * - default WorkbenchStatsShareList: ranked rows with slim share underlines; rows with onSelect act as filters.
 */
import type { CSSProperties, ReactNode } from "react";

export interface StatsShareRow {
  key: string;
  label: ReactNode;
  detail?: ReactNode;
  value: string;
  /** 0 to 1, relative to the largest row. */
  share: number;
  /** Overrides the list colour for this row, such as a model's own hue. */
  barClassName?: string;
  barStyle?: CSSProperties;
  selected?: boolean;
  onSelect?: () => void;
  title?: string;
}

export default function WorkbenchStatsShareList({ barClassName = "bg-fg/40", empty, rows, trackClassName = "bg-fg/6" }: {
  barClassName?: string;
  empty: string;
  rows: readonly StatsShareRow[];
  /** The unfilled rest of each bar, which can carry meaning of its own, such as uncached input. */
  trackClassName?: string;
}) {
  if (!rows.length) return <p className="m-0 py-1 text-[0.8rem] text-fg/muted">{empty}</p>;
  return (
    <ol className="m-0 grid grid-cols-1 gap-y-0.5 p-0">
      {rows.map((row) => {
        const content = (
          <>
            <span aria-hidden="true" className={`absolute inset-x-2 bottom-1 h-[3px] overflow-hidden rounded-full ${trackClassName}`}>
              <span
                className={`block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${row.barClassName ?? barClassName}`}
                style={{ ...row.barStyle, width: `${Math.max(1, row.share * 100)}%` }}
              />
            </span>
            <span className="relative flex min-w-0 items-baseline gap-2 text-[0.8rem]">
              <span className="min-w-0 truncate font-medium text-text">{row.label}</span>
              {row.detail ? <span className="min-w-0 shrink-[4] truncate text-[0.72rem] text-fg/muted">{row.detail}</span> : null}
            </span>
            <span className="relative shrink-0 text-[0.76rem] font-semibold tabular-nums text-text">{row.value}</span>
          </>
        );
        const className = `
          relative flex min-h-9 w-full min-w-0 items-center justify-between gap-3 rounded-md px-2 pb-1.5 text-left
          ${row.selected ? "ring-1 ring-inset ring-text/40" : ""}
        `;
        return (
          <li className="list-none" key={row.key}>
            {row.onSelect ? (
              <button
                aria-pressed={row.selected ?? false}
                className={`${className} hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft`}
                onClick={row.onSelect}
                title={row.title}
                type="button"
              >
                {content}
              </button>
            ) : <div className={className} title={row.title}>{content}</div>}
          </li>
        );
      })}
    </ol>
  );
}
