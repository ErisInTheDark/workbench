"use client";

/*
 * Exports:
 * - default WorkbenchRelativeTime: a live relative time ("5m ago", or short "5m") whose tooltip shows its full local date and time.
 */
import { useTime } from "../../workbench/time/use-time";
import { formatLongTimestamp, formatThreadRelativeTimestamp } from "./thread-view/thread-view-formatters";
import Tooltip from "../ui/Tooltip";

const RELATIVE_TIME_REFRESH_MS = 30_000;

export default function WorkbenchRelativeTime({ className, format = "relative", label, timestampMs, tooltip = true }: {
  className?: string;
  /** `short` drops "ago" for tight controls: "now", "5m". */
  format?: "relative" | "short";
  /** Prefixes the long form, such as "Last used". */
  label?: string;
  timestampMs: number;
  /** Off where an enclosing tooltip already shows the full time. */
  tooltip?: boolean;
}) {
  const now = useTime(RELATIVE_TIME_REFRESH_MS);
  const date = new Date(timestampMs);
  if (!Number.isFinite(date.getTime()) || timestampMs <= 0) return null;
  const long = formatLongTimestamp(timestampMs);
  return (
    <Tooltip content={<span className="whitespace-nowrap">{label ? `${label}: ${long}` : long}</span>} enabled={tooltip} placement="top">
      <time className={className} dateTime={date.toISOString()}>{formatThreadRelativeTimestamp(timestampMs / 1_000, now, format)}</time>
    </Tooltip>
  );
}
