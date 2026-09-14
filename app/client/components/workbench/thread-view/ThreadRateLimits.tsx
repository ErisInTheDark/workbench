/*
 * Exports:
 * - default ThreadRateLimits: render composer controls, provider, quota windows and trailing status.
 */
"use client";

import type { ReactNode } from "react";

import type { RateLimitSnapshot } from "workbench-shared/codex/generated/app-server/v2/RateLimitSnapshot";
import type { RateLimitWindow } from "workbench-shared/codex/generated/app-server/v2/RateLimitWindow";
import type { WorkbenchHarness } from "workbench-shared/types";
import { formatRateLimitResetTime, formatRateLimitWindowLabel } from "../../../workbench/rate-limit-display";
import ThreadHarnessControl from "./ThreadHarnessControl";

function formatUsedPercent (value: number) {
  return `${Math.round(value)}%`;
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
      <span className="font-semibold text-text">{formatRateLimitWindowLabel(window.windowDurationMins, fallback)}</span>
      <span>{formatUsedPercent(100 - window.usedPercent)}</span>
      <span>{formatRateLimitResetTime(window.resetsAt === null ? null : window.resetsAt * 1_000)}</span>
    </span>
  );
}

export default function ThreadRateLimits ({
  canToggleHarness = false,
  harness,
  leadingContent = null,
  onHarnessToggle,
  rateLimits,
  showsHarnessControl = true,
  trailingContent = null,
}: {
  canToggleHarness?: boolean;
  harness: WorkbenchHarness;
  leadingContent?: ReactNode;
  onHarnessToggle?: () => void;
  rateLimits: RateLimitSnapshot | null;
  showsHarnessControl?: boolean;
  trailingContent?: ReactNode;
}) {
  if (!leadingContent && !trailingContent && !canToggleHarness && !rateLimits?.primary && !rateLimits?.secondary && !rateLimits?.limitName) {
    return null;
  }

  const harnessControl = showsHarnessControl ? <ThreadHarnessControl canToggle={canToggleHarness} harness={harness} onToggle={onHarnessToggle} /> : null;
  const leadingControl = showsHarnessControl ? leadingContent : null;

  if (canToggleHarness && !rateLimits?.primary && !rateLimits?.secondary && !rateLimits?.limitName) {
    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[0.78em] leading-[1.6] text-fg/muted">
        <div className="flex items-center gap-3">{leadingControl}{harnessControl}</div>
        {trailingContent}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[0.78em] leading-[1.6] text-fg/muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {leadingControl}
        <div className="flex justify-center">{harnessControl}</div>
        {(rateLimits?.primary || rateLimits?.secondary) ? (
          <p className="mb-0 flex flex-wrap gap-x-5 gap-y-1">
            {rateLimits.primary ? (
              <RateLimitWindowText fallback="Primary" window={rateLimits.primary} />
            ) : null}
            {rateLimits.secondary ? (
              <RateLimitWindowText fallback="Secondary" window={rateLimits.secondary} />
            ) : null}
          </p>
        ) : null}
      </div>
      {trailingContent}
    </div>
  );
}
