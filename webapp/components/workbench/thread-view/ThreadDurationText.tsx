"use client";

import { Fragment } from "react";

import { formatThreadDuration } from "./thread-view-primitives";

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
  const value = formatThreadDuration(durationMs);
  if (!value) {
    return null;
  }

  return (
    <span className={joinClasses(className)}>
      {value.split(" ").map((part, index, parts) => (
        <Fragment key={`${part}:${index}`}>
          <span className={EMPHASIS_CLASS}>{part}</span>
          {index < parts.length - 1 ? " " : null}
        </Fragment>
      ))}
    </span>
  );
}
