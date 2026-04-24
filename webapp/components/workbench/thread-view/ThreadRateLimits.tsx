"use client";

import type { RateLimitSnapshot } from "../../../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { RateLimitWindow } from "../../../lib/codex/generated/app-server/v2/RateLimitWindow";

function formatWindowLabel (window: RateLimitWindow, fallback: string) {
  const minutes = window.windowDurationMins;
  if (minutes === null) {
    return fallback;
  }

  if (minutes === 60 * 24 * 7) {
    return "Weekly";
  }

  if (minutes % (60 * 24) === 0) {
    return `${minutes / (60 * 24)}d`;
  }

  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }

  return `${minutes}m`;
}

function formatUsedPercent (value: number) {
  return `${Math.round(value)}%`;
}

function formatResetTimestamp (timestampSeconds: number | null) {
  if (timestampSeconds === null) {
    return "No reset";
  }

  const resetDate = new Date(timestampSeconds * 1000);
  const now = new Date();
  if (
    resetDate.getFullYear() === now.getFullYear()
    && resetDate.getMonth() === now.getMonth()
    && resetDate.getDate() === now.getDate()
  ) {
    return resetDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  return resetDate.toLocaleDateString([], {
    day: "numeric",
    month: "short",
  });
}

function RateLimitWindowText ({
  fallback,
  window,
}: {
  fallback: string;
  window: RateLimitWindow;
}) {
  return (
    <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
      <span className="font-semibold text-text">{formatWindowLabel(window, fallback)}</span>
      <span>{formatUsedPercent(100 - window.usedPercent)}</span>
      <span>{formatResetTimestamp(window.resetsAt)}</span>
    </span>
  );
}

export default function ThreadRateLimits ({ rateLimits }: { rateLimits: RateLimitSnapshot | null }) {
  if (!rateLimits?.primary && !rateLimits?.secondary) {
    return null;
  }

  return (
    <p className="mt-2 mb-0 flex flex-wrap gap-x-5 gap-y-1 px-1 text-[0.78em] leading-[1.6] text-muted">
      {rateLimits.primary ? (
        <RateLimitWindowText fallback="Primary" window={rateLimits.primary} />
      ) : null}
      {rateLimits.secondary ? (
        <RateLimitWindowText fallback="Secondary" window={rateLimits.secondary} />
      ) : null}
    </p>
  );
}
