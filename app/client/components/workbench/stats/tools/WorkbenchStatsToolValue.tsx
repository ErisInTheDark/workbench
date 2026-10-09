"use client";

/*
 * Exports:
 * - default WorkbenchStatsToolValue: every wb tool's calls against its always-on prompt cost, ordered by any column; hovering a tool's trend names the threads behind each period.
 */
import { useState, type PointerEvent } from "react";
import type { WorkbenchStatsTools } from "workbench-shared/workbench/stats/workbench-stats-tools-contract";
import WorkbenchThreadReferenceList from "../../WorkbenchThreadReferenceList";
import WorkbenchTooltip from "../../WorkbenchTooltip";
import useStats from "../use-stats";
import WorkbenchStatsSkeleton, { statsReloadingClassName, statsRevealClassName } from "../WorkbenchStatsSkeleton";
import WorkbenchStatsSparkline from "../WorkbenchStatsSparkline";
import { compactNumber, formatStatsBucket } from "../stats-formatters";
import { statsThreadIdentity } from "../stats-thread-identity";
import { statsToolValueRows, type StatsToolSort, type StatsToolSortKey, type StatsToolValueRow } from "workbench-shared/workbench/stats/workbench-stats-tool-value";

const columns = "grid grid-cols-[minmax(0,1fr)_4.5rem] items-center gap-x-5 sm:grid-cols-[minmax(9rem,1fr)_minmax(12rem,2fr)_minmax(8rem,1fr)_6rem]";

/** Low value is the point of the list, so it reads warm; well-used tools cool off. */
function valueTone(value: number | null) {
  if (value === null) return "text-fg/muted";
  if (value < 1) return "text-hue-25";
  if (value < 25) return "text-hue-60";
  return "text-hue-150";
}

function formatValue(value: number | null) {
  if (value === null) return "-";
  return value >= 100 ? compactNumber(value) : value.toFixed(value < 10 ? 2 : 1);
}

function PeriodDetail({ bucketStarts, index, row, threads, unit }: {
  bucketStarts: readonly number[];
  index: number;
  row: StatsToolValueRow;
  threads: WorkbenchStatsTools["threads"];
  unit: "day" | "week";
}) {
  const calls = row.buckets[index] ?? 0;
  const callers = row.bucketThreads[index] ?? [];
  const references = callers.flatMap(({ calls: threadCalls, thread }) => {
    const named = threads[thread];
    const identity = named ? statsThreadIdentity(named) : null;
    return named && identity ? [{
      detail: <span className="tabular-nums">{compactNumber(threadCalls)}</span>,
      identity: { harness: identity.harness, threadId: identity.threadId }, projectId: identity.projectId, title: named.title || "Untitled thread",
    }] : [];
  });
  return (
    <div className="w-72 max-w-full space-y-1 text-[0.76rem]">
      <p className="m-0 flex items-baseline justify-between gap-3 px-1">
        <span className="font-semibold text-text">{bucketStarts[index] === undefined ? "" : formatStatsBucket(bucketStarts[index], unit)}</span>
        <span className="tabular-nums text-fg/muted">{calls ? `${compactNumber(calls)} ${calls === 1 ? "call" : "calls"}` : "no calls"}</span>
      </p>
      {references.length ? (
        <div className="-mx-2"><WorkbenchThreadReferenceList references={references} /></div>
      ) : null}
    </div>
  );
}

/** The trend keeps its quiet sparkline look; scrubbing it picks a period and its tooltip names who called. */
function CallTrend({ bucketStarts, row, threads, unit }: {
  bucketStarts: readonly number[];
  row: StatsToolValueRow;
  threads: WorkbenchStatsTools["threads"];
  unit: "day" | "week";
}) {
  // The hairline follows the pointer only while it is over the trend; the tooltip keeps the last scrubbed
  // period, so moving into the tooltip to open a thread does not jump it to another period.
  const [index, setIndex] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const last = row.buckets.length - 1;
  const shown = picked ?? last;
  const scrub = (event: PointerEvent<HTMLSpanElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const next = Math.min(last, Math.max(0, Math.round((event.clientX - box.left) / Math.max(1, box.width) * last)));
    setIndex(next);
    setPicked(next);
  };
  if (!row.calls || last < 1) return <span className="relative block h-7 min-w-0 flex-1" />;
  return (
    <WorkbenchTooltip
      content={<PeriodDetail bucketStarts={bucketStarts} index={shown} row={row} threads={threads} unit={unit} />}
      interactive
      placement="top"
    >
      <span className="relative block h-7 min-w-0 flex-1 cursor-crosshair" onPointerLeave={() => setIndex(null)} onPointerMove={scrub}>
        <WorkbenchStatsSparkline className="text-hue-170" values={row.buckets} />
        {index !== null ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-hue-170/60"
            style={{ left: `${index / last * 100}%` }}
          />
        ) : null}
      </span>
    </WorkbenchTooltip>
  );
}

function Row({ bucketStarts, maxCost, row, threads, unit }: {
  bucketStarts: readonly number[];
  maxCost: number;
  row: StatsToolValueRow;
  threads: WorkbenchStatsTools["threads"];
  unit: "day" | "week";
}) {
  return (
    <li className={`${columns} list-none rounded-md px-2 py-1 hover:bg-fg/4`}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-[0.78rem] text-text" title={row.tool}>{row.tool}</span>
        {row.retired ? <span className="shrink-0 rounded-full bg-fg/7 px-1.5 text-[0.64rem] font-medium text-fg/muted" title="No provider serves this tool any more; calls are from history.">retired</span> : null}
      </span>
      <span className="hidden min-w-0 items-center gap-3 sm:flex" title={`${row.calls.toLocaleString()} calls in ${row.threads.toLocaleString()} threads`}>
        <CallTrend bucketStarts={bucketStarts} row={row} threads={threads} unit={unit} />
        <span className="w-10 shrink-0 text-right text-[0.74rem] tabular-nums text-text">{compactNumber(row.calls)}</span>
      </span>
      <span
        className="hidden min-w-0 items-center gap-2 sm:flex"
        title={row.retired ? "Not in the served catalogue" : `≈${Math.round(row.specTokens)} spec + ≈${Math.round(row.docsTokens)} docs tokens, averaged across providers`}
      >
        <span className="relative flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-fg/6">
          <span className="h-full bg-hue-210 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${row.specTokens / maxCost * 100}%` }} />
          <span className="h-full bg-hue-300 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${row.docsTokens / maxCost * 100}%` }} />
        </span>
        <span className="w-10 shrink-0 text-right text-[0.74rem] tabular-nums text-text">{row.cost ? `≈${compactNumber(Math.round(row.cost))}` : "-"}</span>
      </span>
      <span
        className={`text-right text-[0.8rem] font-semibold tabular-nums ${valueTone(row.value)}`}
        title={row.value === null ? "No always-on prompt cost to weigh" : `${row.calls.toLocaleString()} calls ÷ ≈${Math.round(row.cost)} tokens × 100`}
      >
        {formatValue(row.value)}
      </span>
    </li>
  );
}

const HEADERS: ReadonlyArray<{ key: StatsToolSortKey; label: string; className?: string; firstDescending: boolean }> = [
  { key: "tool", label: "Tool", firstDescending: false },
  { key: "calls", label: "Calls", className: "hidden sm:flex", firstDescending: true },
  { key: "cost", label: "Prompt cost", className: "hidden sm:flex", firstDescending: true },
  // Lowest value first is the question the table answers.
  { key: "value", label: "Calls / 100 tok", className: "justify-end", firstDescending: false },
];

export default function WorkbenchStatsToolValue() {
  const { range } = useStats();
  const { data, loading } = useStats.tools();
  const [sort, setSort] = useState<StatsToolSort>({ key: "value", descending: false });
  const rows = data ? statsToolValueRows(data.tools, sort) : null;
  const maxCost = Math.max(1, ...(rows ?? []).map(({ cost }) => cost));
  const unit = range === "365d" ? "week" : "day";
  return (
    <section aria-busy={loading} aria-labelledby="tool-value-heading" className={`space-y-3 [--hue-chroma:55%] ${statsReloadingClassName(loading && Boolean(data))}`}>
      <div className="space-y-0.5">
        <h2 className="m-0 text-[1rem] font-semibold text-text" id="tool-value-heading">Value per prompt token</h2>
        <p className="m-0 text-[0.72rem] text-fg/muted">
          calls per 100 tokens of <span className="text-hue-210">spec</span> and <span className="text-hue-300">docs</span> every turn carries; hover a trend for who called
        </p>
      </div>
      <div className={`${columns} px-2 text-[0.68rem] font-medium text-fg/muted`} role="row">
        {HEADERS.map(({ className = "", firstDescending, key, label }) => {
          const active = sort.key === key;
          return (
            <button
              aria-sort={active ? sort.descending ? "descending" : "ascending" : "none"}
              className={`
                -mx-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-fg/6 hover:text-text
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
                ${active ? "text-text" : ""} ${className}
              `}
              key={key}
              onClick={() => setSort((current) => ({ key, descending: current.key === key ? !current.descending : firstDescending }))}
              title={`Order by ${label.toLowerCase()}`}
              type="button"
            >
              {label}
              <span aria-hidden="true" className={active ? "" : "opacity-0"}>{active && sort.descending ? "↓" : "↑"}</span>
            </button>
          );
        })}
      </div>
      {!rows ? (
        <ol aria-hidden="true" className="m-0 grid gap-y-0.5 p-0">
          {Array.from({ length: 12 }, (_, index) => (
            <li className={`${columns} list-none px-2 py-1`} key={index}>
              <WorkbenchStatsSkeleton className="h-3" style={{ width: `${70 - (index % 4) * 12}%` }} />
              <span className="hidden h-7 items-center sm:flex"><WorkbenchStatsSkeleton className="h-1.5 w-full rounded-full opacity-60" /></span>
              <WorkbenchStatsSkeleton className="hidden h-1.5 rounded-full sm:block" />
              <WorkbenchStatsSkeleton className="ml-auto h-3 w-10" />
            </li>
          ))}
        </ol>
      ) : !rows.length ? (
        <p className={`m-0 py-1 text-[0.8rem] text-fg/muted ${statsRevealClassName}`}>No wb tools are catalogued or used in this period.</p>
      ) : (
        <ol className={`m-0 grid gap-y-0.5 p-0 ${statsRevealClassName}`}>
          {rows.map((row) => (
            <Row bucketStarts={data!.tools.bucketStarts} key={row.tool} maxCost={maxCost} row={row} threads={data!.tools.threads} unit={unit} />
          ))}
        </ol>
      )}
    </section>
  );
}
