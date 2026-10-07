/*
 * Exports:
 * - default ThreadDurationText: render a formatted thread duration with optional emphasis. Keywords: thread, duration, metadata, text.
 */
"use client";

import { formatDuration } from "workbench-shared/workbench/format-duration";

function joinClasses(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

const EMPHASIS_CLASS = "font-medium text-text";

export default function ThreadDurationText({
  className,
  durationMs,
}: {
  className?: string;
  durationMs: number | null;
}) {
  const value = formatDuration(durationMs);
  if (!value) {
    return null;
  }

  return (
    <span className={joinClasses(className)}>
      {value.split(" ").map((part, index, parts) => (
        <span key={index}>
          <span className={EMPHASIS_CLASS}>
            {[...part].map((character, characterIndex) => (
              <span
                className="inline-block animate-tick motion-reduce:animate-none"
                key={`${characterIndex}:${character}`}
              >
                {character}
              </span>
            ))}
          </span>
          {index < parts.length - 1 ? " " : null}
        </span>
      ))}
    </span>
  );
}
