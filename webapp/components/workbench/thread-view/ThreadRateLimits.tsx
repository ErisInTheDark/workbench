/*
 * Exports:
 * - default ThreadRateLimits: render harness, account quota windows, auth hints, and optional trailing composer status content. Keywords: thread, rate limits, harness, composer.
 */
"use client";

import type { ReactNode } from "react";

import type { RateLimitSnapshot } from "../../../lib/codex/generated/app-server/v2/RateLimitSnapshot";
import type { RateLimitWindow } from "../../../lib/codex/generated/app-server/v2/RateLimitWindow";
import type { WorkbenchHarness } from "../../../lib/types";
import { HarnessIcon } from "../workbench-icons";

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

export default function ThreadRateLimits ({
  canToggleHarness = false,
  harness,
  onHarnessToggle,
  rateLimits,
  trailingContent = null,
}: {
  canToggleHarness?: boolean;
  harness: WorkbenchHarness;
  onHarnessToggle?: () => void;
  rateLimits: RateLimitSnapshot | null;
  trailingContent?: ReactNode;
}) {
  if (!trailingContent && !canToggleHarness && harness !== "copilot" && !rateLimits?.primary && !rateLimits?.secondary && !rateLimits?.limitName) {
    return null;
  }

  const harnessLabel = harness === "copilot" ? "Copilot" : "Codex";
  const harnessControl = canToggleHarness ? (
    <button
      type="button"
      className="inline-flex items-center justify-center min-w-28 gap-2 rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 py-1.5 font-semibold text-text transition hover:border-[color-mix(in_srgb,var(--text)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft"
      onClick={onHarnessToggle}
    >
      <HarnessIcon className="size-4" harness={harness} />
      <span>{harnessLabel}</span>
    </button>
  ) : (
    <span className="inline-flex items-center gap-2 font-semibold text-text">
      <HarnessIcon className="size-4" harness={harness} />
      <span>{harnessLabel}</span>
    </span>
  );

  if (canToggleHarness && harness !== "copilot" && !rateLimits?.primary && !rateLimits?.secondary && !rateLimits?.limitName) {
    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[0.78em] leading-[1.6] text-muted">
        <div className="flex items-center gap-3">{harnessControl}</div>
        {trailingContent}
      </div>
    );
  }

  if (harness === "copilot") {
    const isAuthRequired = rateLimits?.limitId === "copilot:auth";

    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[0.78em] leading-[1.6] text-muted">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
                  <span>{formatResetTimestamp(rateLimits.primary.resetsAt)}</span>
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

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-[0.78em] leading-[1.6] text-muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
