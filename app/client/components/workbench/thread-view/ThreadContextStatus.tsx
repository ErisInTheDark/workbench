/*
 * Exports:
 * - default ThreadContextStatus: render context-window usage and Codex compact action beside composer quota stats.
 */
"use client";

import { useState } from "react";

import type { ThreadPayload } from "workbench-shared/types";
import WorkbenchProgressWheel from "../WorkbenchProgressWheel";
import { CompactIcon } from "../workbench-icons";

function formatTokenCount (value: number) {
  return new Intl.NumberFormat([], {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent (value: number) {
  return `${Math.round(value)}%`;
}

function formatContextStatusTitle ({
  contextTokens,
  contextWindow,
  remainingTokens,
}: {
  contextTokens: number | null;
  contextWindow: number | null;
  remainingTokens: number | null;
}) {
  if (contextTokens === null || contextWindow === null || remainingTokens === null) {
    return "Context window usage unavailable";
  }

  return `Last reported context usage: ${formatTokenCount(remainingTokens)} tokens left of ${formatTokenCount(contextWindow)}. ${formatTokenCount(contextTokens)} used.`;
}

function isThreadActive (thread: ThreadPayload) {
  return thread.status === "active" || thread.status.startsWith("active:");
}

export default function ThreadContextStatus ({
  onCompactThread,
  thread,
}: {
  onCompactThread: (thread: ThreadPayload) => Promise<ThreadPayload | null>;
  thread: ThreadPayload;
}) {
  const [isCompacting, setIsCompacting] = useState(false);
  const [error, setError] = useState("");
  if (thread.isDraft) return null;
  const tokenUsage = thread.tokenUsage;
  const contextTokens = tokenUsage?.last.inputTokens ?? null;
  const contextWindow = tokenUsage?.modelContextWindow ?? null;
  const remainingTokens = contextTokens !== null && contextWindow !== null
    ? Math.max(0, contextWindow - contextTokens)
    : null;
  const usedPercent = contextTokens !== null && contextWindow !== null && contextWindow > 0
    ? (contextTokens / contextWindow) * 100
    : null;
  const contextStatusTitle = formatContextStatusTitle({
    contextTokens,
    contextWindow,
    remainingTokens,
  });
  const canCompact = thread.harness === "codex" && !thread.isDraft;
  const active = isThreadActive(thread);
  const compactDisabled = isCompacting || active;
  const compactTitle = active
    ? "Compact is unavailable while the thread is active"
    : isCompacting
      ? "Compacting context"
      : "Compact thread context";

  return (
    <div className="min-w-0 text-right">
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1" title={contextStatusTitle}>
        {usedPercent !== null ? (
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <WorkbenchProgressWheel percent={usedPercent} />
            <span className="font-semibold text-text">{formatPercent(usedPercent)}</span>
            <span>window size</span>
          </span>
        ) : (
          <span>Context unavailable</span>
        )}
        {canCompact ? (
          <button
            type="button"
            className="inline-flex h-8 items-center gap-2 rounded-full px-2.5 font-medium text-fg/muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-fg/muted"
            disabled={compactDisabled}
            title={compactTitle}
            aria-label={compactTitle}
            onClick={() => {
              if (compactDisabled) {
                return;
              }

              setError("");
              setIsCompacting(true);
              void onCompactThread(thread)
                .catch((compactError) => {
                  setError(compactError instanceof Error ? compactError.message : "Unable to compact context.");
                })
                .finally(() => {
                  setIsCompacting(false);
                });
            }}
          >
            <CompactIcon size={16} />
            <span>{isCompacting ? "Compacting" : "Compact"}</span>
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-1 mb-0 text-danger">{error}</p>
      ) : null}
    </div>
  );
}
