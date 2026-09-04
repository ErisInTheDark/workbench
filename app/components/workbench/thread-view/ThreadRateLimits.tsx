/*
 * Exports:
 * - default ThreadRateLimits: render leading composer controls, harness, account quota windows, auth hints, and optional trailing status content. Keywords: thread, rate limits, harness, composer, project.
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
  if (!leadingContent && !trailingContent && !canToggleHarness && harness !== "copilot" && harness !== "opencode" && !rateLimits?.primary && !rateLimits?.secondary && !rateLimits?.limitName) {
    return null;
  }

  const harnessControl = showsHarnessControl ? <ThreadHarnessControl canToggle={canToggleHarness} harness={harness} onToggle={onHarnessToggle} /> : null;
  const leadingControl = showsHarnessControl ? leadingContent : null;

  if (canToggleHarness && harness !== "copilot" && !rateLimits?.primary && !rateLimits?.secondary && !rateLimits?.limitName) {
    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[0.78em] leading-[1.6] text-muted">
        <div className="flex items-center gap-3">{leadingControl}{harnessControl}</div>
        {trailingContent}
      </div>
    );
  }

  if (harness === "copilot") {
    const isAuthRequired = rateLimits?.limitId === "copilot:auth";

    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[0.78em] leading-[1.6] text-muted">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {leadingControl}
          <div className="flex justify-center">{harnessControl}</div>
          <p className="mb-0 flex flex-wrap gap-x-5 gap-y-1">
            {isAuthRequired ? (
              <span className="inline-flex flex-wrap items-baseline gap-2">
                <span>{rateLimits?.limitName ?? "Sign in to Copilot CLI."}</span>
                <span>Run</span>
                <span className="font-mono text-text">copilot</span>
                <span>then</span>
                <span className="font-mono text-text">/login</span>
              </span>
            ) : rateLimits?.limitName && rateLimits.primary ? (
              <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
                <span className="font-semibold text-text">{rateLimits.limitName}</span>
                <span>{formatUsedPercent(100 - rateLimits.primary.usedPercent)} ({rateLimits.secondary?.usedPercent ?? "-"})</span>
                {rateLimits.primary.resetsAt && rateLimits.primary.resetsAt * 1000 > Date.now() ? (
                  <span>{formatRateLimitResetTime(rateLimits.primary.resetsAt * 1_000)}</span>
                ) : null}
              </span>
            ) : (
              <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
                <span>Premium quota unavailable</span>
              </span>
            )}
          </p>
        </div>
        {trailingContent}
      </div>
    );
  }

  if (harness === "opencode") {
    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[0.78em] leading-[1.6] text-muted">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {leadingControl}
          <div className="flex justify-center">{harnessControl}</div>
          <p className="mb-0 flex flex-wrap gap-x-5 gap-y-1">
            <span className="inline-flex items-baseline gap-2 whitespace-nowrap">
              <span>OpenCode bridge</span>
            </span>
          </p>
        </div>
        {trailingContent}
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[0.78em] leading-[1.6] text-muted">
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
