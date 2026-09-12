/*
 * Keywords: thread, timestamp, local time, message footer.
 * Exports:
 * - default ThreadMessageTimestamp: render a valid event time beneath transcript content.
 */
import { formatThreadTimestamp } from "./thread-view-formatters";

export default function ThreadMessageTimestamp({
  align = "left",
  className = "",
  timestampSeconds,
}: {
  align?: "left" | "right";
  className?: string;
  timestampSeconds: number | null;
}) {
  if (timestampSeconds === null || !Number.isFinite(timestampSeconds)) return null;
  const date = new Date(timestampSeconds * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  return (
    <p className={`
      m-0 text-[0.67em] leading-[1.5] text-fg/muted
      ${align === "right" ? "text-right" : ""}
      ${className}
    `}>
      <time dateTime={date.toISOString()}>{formatThreadTimestamp(timestampSeconds)}</time>
    </p>
  );
}
