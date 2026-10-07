/*
 * Keywords: thread, timestamp, relative time, message footer.
 * Exports:
 * - default ThreadMessageTimestamp: a live relative event time beneath transcript content, with its full time on hover.
 */
import WorkbenchRelativeTime from "../WorkbenchRelativeTime";

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
  return (
    <p className={`
      m-0 text-[0.67em] leading-[1.5] text-fg/muted
      ${align === "right" ? "text-right" : ""}
      ${className}
    `}>
      <WorkbenchRelativeTime timestampMs={timestampSeconds * 1_000} />
    </p>
  );
}
