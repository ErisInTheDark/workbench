/*
 * Exports:
 * - StatsShareRow: one ranked row with its share of the largest row.
 * - default ShareList: ranked rows with slim share underlines; rows with onSelect act as filters; null rows hold the list's shape while loading.
 */
import type { CSSProperties, ReactNode } from "react";
import Skeleton, { statsRevealClassName } from "./Skeleton";

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

const rowClassName = "relative flex min-h-9 w-full min-w-0 items-center justify-between gap-3 rounded-md px-2 pb-1.5 text-left";

export default function ShareList({ barClassName = "bg-fg/40", empty, loadingRows = 4, rows, trackClassName = "bg-fg/6" }: {
  barClassName?: string;
  empty: string;
  /** Placeholder rows while loading; the usual length of the list. */
  loadingRows?: number;
  /** Null until the list's data arrives. */
  rows: readonly StatsShareRow[] | null;
  /** The unfilled rest of each bar, which can carry meaning of its own, such as uncached input. */
  trackClassName?: string;
}) {
  if (!rows) {
    return (
      <ol aria-hidden="true" className="m-0 grid grid-cols-1 gap-y-0.5 p-0">
        {Array.from({ length: loadingRows }, (_, index) => (
          <li className={`list-none ${rowClassName}`} key={index}>
            <Skeleton className="h-3" style={{ width: `${Math.max(20, 55 - index * 9)}%` }} />
            <Skeleton className="h-3 w-10" />
            <Skeleton className="absolute inset-x-2 bottom-1 h-[3px] rounded-full" />
          </li>
        ))}
      </ol>
    );
  }
  if (!rows.length) return <p className={`m-0 py-1 text-[0.8rem] text-fg/muted ${statsRevealClassName}`}>{empty}</p>;
  return (
    <ol className={`m-0 grid grid-cols-1 gap-y-0.5 p-0 ${statsRevealClassName}`}>
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
        const className = `${rowClassName} ${row.selected ? "ring-1 ring-inset ring-text/40" : ""}`;
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
