"use client";

/*
 * Exports:
 * - default WorkbenchStatsLimitMeter: one limit window's what-is-left gauge with even-rationing notches; hovering or stepping
 *   through it by keyboard highlights a notch or the share between notches, and its header compares them with an even pace.
 */
import { useRef, useState, type KeyboardEvent } from "react";
import type { WorkbenchStatsSectionData } from "workbench-shared/workbench/stats/workbench-stats-contract";
import { formatPercent, formatResetIn } from "../stats-formatters";
import StatsTrend from "../StatsTrend";
import { rationParts, rationStepMinutes, type RationPart, type RationShare } from "./stats-ration";

type RateWindow = NonNullable<WorkbenchStatsSectionData<"limits">["rateLimits"][number]["samples"][number]["primary"]>;

/** Pointer distance, in pixels, within which a notch wins over the share around it. */
const MARK_REACH_PX = 5;

/** Highlights are a brighter, more vivid take on the bar's hue, shared by a highlighted share and its notch circles. */
function pressure(usedPercent: number) {
  return usedPercent >= 85 ? { bar: "bg-hue-25", text: "text-hue-25", highlight: "bg-hue-bright-25", border: "border-hue-bright-25" }
    : usedPercent >= 60 ? { bar: "bg-hue-75", text: "text-hue-75", highlight: "bg-hue-bright-75", border: "border-hue-bright-75" }
      : { bar: "bg-hue-150", text: "text-hue-150", highlight: "bg-hue-bright-150", border: "border-hue-bright-150" };
}

const DAY_MS = 86_400_000;

/** When a share falls: its hour, its day near now, or its date. */
function formatWhen(share: RationShare, durationMinutes: number, now: number) {
  const step = rationStepMinutes(durationMinutes);
  const middle = new Date((share.from + share.to) / 2);
  if (step <= 60) return new Date(share.from).toLocaleTimeString(undefined, { hour: "numeric" });
  if (step > 24 * 60) return middle.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(middle) - midnight(new Date(now))) / DAY_MS);
  return days === 0 ? "today" : days === 1 ? "tomorrow" : middle.toLocaleDateString(undefined, { weekday: "short" });
}

/** Ahead of an even pace is good news: more is left, or more can be spent, than an even pace would allow. */
function Versus({ actual, ideal }: { actual: number; ideal: number }) {
  const difference = actual - ideal;
  const sign = Math.abs(difference) < 0.5 ? "" : difference > 0 ? "+" : "−";
  return <StatsTrend better="up" change={difference} label={`${sign}${formatPercent(Math.abs(difference))}`} size={12} />;
}

/** The hovered item reads bold and full-contrast; its neighbour fades back. */
function Item({ durationMinutes, focused, now, part }: { durationMinutes: number; focused: boolean; now: number; part: RationPart }) {
  const emphasis = focused ? "font-semibold text-text" : "opacity-55";
  if (part.kind === "mark" && part.edge === "reset") return <span className={emphasis}>reset</span>;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap ${emphasis}`}>
      {part.kind === "share" ? <span>{formatWhen(part, durationMinutes, now)}</span> : null}
      <span className="text-text">{formatPercent(part.kind === "share" ? part.sharePercent : part.leftPercent)}</span>
      <Versus actual={part.kind === "share" ? part.sharePercent : part.leftPercent} ideal={part.idealPercent} />
    </span>
  );
}

export default function WorkbenchStatsLimitMeter({ label, now, window }: { label: string; now: number; window: RateWindow }) {
  const track = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const left = Math.max(0, 100 - window.usedPercent);
  const tone = pressure(window.usedPercent);
  const resetIn = formatResetIn(window.resetsAt, now);
  const parts = rationParts({ ...window, leftPercent: left }, now);
  const durationMinutes = window.durationMinutes ?? 0;
  const position = (index: number) => {
    const part = parts[index];
    return part?.kind === "mark" ? part.leftPercent : 0;
  };
  const nowIndex = parts.length - 1;
  // The hovered part and the one to its left: a notch with the share before it, or a share with the notch before it.
  const near = focus === null ? [] : [focus - 1, focus].filter((index) => index >= 0);

  // The reset and now ends have no notch, so only the drawn notches and the shares between them can be inspected.
  const lastShare = nowIndex - 1;
  const pick = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect?.width) return null;
    const reach = MARK_REACH_PX / rect.width * 100;
    const pointer = (clientX - rect.left) / rect.width * 100;
    if (pointer > left + reach) return null;
    const x = Math.min(left, Math.max(0, pointer));
    let nearest = -1;
    let nearestDistance = Infinity;
    for (const [index, part] of parts.entries()) {
      const distance = part.kind === "mark" && part.edge === null ? Math.abs(part.leftPercent - x) : Infinity;
      if (distance < nearestDistance) [nearest, nearestDistance] = [index, distance];
    }
    // A notch only reaches halfway into the share on the pointer's side, so a sliver of a share stays hoverable.
    const across = x > position(nearest) ? nearest + 2 : nearest - 2;
    if (nearestDistance <= Math.min(reach, Math.abs(position(across) - position(nearest)) / 2)) return nearest;
    const share = parts.findIndex((part, index) => part.kind === "share" && x >= position(index - 1) && x <= position(index + 1));
    return share >= 0 ? share : null;
  };
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = focus ?? nowIndex;
    const next = { ArrowLeft: from - 1, ArrowRight: from + 1, Home: 1, End: lastShare }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setFocus(Math.min(lastShare, Math.max(1, next)));
  };

  return (
    <>
      {/* While inspecting, the readout takes over the right of the header line, so nothing below moves. */}
      <div className="flex h-[1.1rem] items-center justify-between gap-2 text-[0.74rem] tabular-nums">
        <span className="font-medium text-text">{label}</span>
        {focus === null ? (
          <span className="text-fg/muted">
            <span className={`font-semibold ${tone.text}`}>{formatPercent(left)} left</span>
            {resetIn ? ` · ${resetIn}` : ""}
          </span>
        ) : (
          <span aria-live="polite" className="flex min-w-0 items-center gap-3 text-[0.68rem] text-fg/muted">
            {near.map((index) => <Item durationMinutes={durationMinutes} focused={index === focus} key={index} now={now} part={parts[index]!} />)}
          </span>
        )}
      </div>
      <div
        aria-label={parts.length ? `${label} rationing. Use left and right arrow keys to compare each step with an even pace.` : undefined}
        className={`
          relative -my-1 rounded-sm py-2 outline-none focus-visible:ring-2 focus-visible:ring-accent-soft
          ${parts.length ? "cursor-crosshair" : ""}
        `}
        onBlur={() => setFocus(null)}
        onKeyDown={parts.length ? step : undefined}
        onPointerLeave={() => setFocus(null)}
        onPointerMove={parts.length ? (event) => setFocus(pick(event.clientX)) : undefined}
        role={parts.length ? "group" : undefined}
        tabIndex={parts.length ? 0 : undefined}
      >
        <div
          aria-label={`${label} ${formatPercent(left)} left`}
          aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(left)}
          className="relative h-1.5 overflow-hidden rounded-full bg-fg/8"
          ref={track}
          role="meter"
        >
          <div className={`h-full rounded-full ${tone.bar}`} style={{ width: `${Math.max(1, left)}%` }} />
          {near.map((index) => parts[index]!.kind === "share" ? (
            <span
              aria-hidden="true"
              className={`absolute inset-y-0 ${tone.highlight}`}
              key={index}
              style={{ left: `${position(index - 1)}%`, width: `${position(index + 1) - position(index - 1)}%` }}
            />
          ) : null)}
          {/* Notches in the page colour: what should still be left at each step if what is left now is spread evenly. */}
          {parts.map((part, index) => part.kind === "mark" && part.edge === null ? (
            <span aria-hidden="true" className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-bg" key={index} style={{ left: `${part.leftPercent}%` }} />
          ) : null)}
        </div>
        {near.map((index) => {
          const part = parts[index]!;
          return part.kind === "mark" ? (
            <span
              aria-hidden="true"
              className={`
                pointer-events-none absolute top-1/2 -translate-1/2 rounded-full border-2 bg-canvas
                ${tone.border}
                ${index === focus ? "size-3" : "size-2.5"}
              `}
              key={index}
              style={{ left: `${part.leftPercent}%` }}
            />
          ) : null;
        })}
      </div>
    </>
  );
}
