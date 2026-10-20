/*
 * Exports:
 * - default ThreadContextStatus: render context-window usage and the compact action, pending while any compaction runs and blocked only by live turns, beside composer quota stats;
 *   the compact action shows the composer's held compact-first send filling up.
 */
"use client";

import { useState } from "react";

import HoldConfirmationRail from "../../ui/HoldConfirmationRail";
import { holdProgressStyle } from "../../ui/use-hold-to-confirm";
import { COMPACT_SEND_HOLD_MS } from "./use-compact-send-hold";

import type { WorkbenchThreadLifecycle } from "workbench-shared/workbench/thread/thread-state";
import type { ThreadHead } from "../../../workbench/thread/ThreadStore";
import { isThreadStatusActive, isThreadStatusWaitingOnUserInput } from "../thread-attention";
import { useThread } from "../use-thread";
import WorkbenchProgressWheel from "../WorkbenchProgressWheel";
import WorkbenchSpinningBorder from "../WorkbenchSpinningBorder";
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
  contextTokens: number;
  contextWindow: number;
  remainingTokens: number;
}) {
  return `Last reported context usage: ${formatTokenCount(remainingTokens)} tokens left of ${formatTokenCount(contextWindow)}. ${formatTokenCount(contextTokens)} used.`;
}

export default function ThreadContextStatus ({
  lifecycle,
  launching = false,
  onCompactThread,
  sendHolding = false,
  snoozed = false,
  thread,
}: {
  lifecycle?: WorkbenchThreadLifecycle;
  launching?: boolean;
  onCompactThread: () => Promise<void>;
  /** The composer's Enter is held to confirm a send that compacts first. */
  sendHolding?: boolean;
  snoozed?: boolean;
  thread: ThreadHead;
}) {
  const [isRequestingCompaction, setIsRequestingCompaction] = useState(false);
  const [error, setError] = useState("");
  // Automatic and other clients' compactions reach this view only as the live summary fact.
  const summary = useThread.summary(thread.isDraft ? null : thread.id);
  const isCompacting = isRequestingCompaction || Boolean(summary?.summary.facts.compacting);
  if (thread.isDraft && !launching) return null;
  const tokenUsage = thread.tokenUsage;
  const contextTokens = tokenUsage?.last.inputTokens ?? null;
  const contextWindow = tokenUsage?.modelContextWindow ?? null;
  const remainingTokens = contextTokens !== null && contextWindow !== null
    ? Math.max(0, contextWindow - contextTokens)
    : null;
  const usedPercent = contextTokens !== null && contextWindow !== null && contextWindow > 0
    ? (contextTokens / contextWindow) * 100
    : null;
  const contextStatusTitle = usedPercent !== null && contextTokens !== null && contextWindow !== null && remainingTokens !== null
    ? formatContextStatusTitle({ contextTokens, contextWindow, remainingTokens })
    : undefined;
  const canCompact = !thread.isDraft || launching;
  const inactiveByWorkbenchState = lifecycle?.kind === "stopped"
    || (lifecycle?.kind === "needsAttention"
      && (lifecycle.reason === "noActiveTurn" || lifecycle.reason === "interrupted" || lifecycle.reason === "providerFailed"
        || lifecycle.reason === "agentBlocked"
        || (snoozed && lifecycle.reason === "pendingInput")));
  // A held questionnaire keeps the thread waiting on input after its turn ended; only a live turn blocks compaction.
  const heldQuestionnaire = isThreadStatusWaitingOnUserInput(thread.status) && thread.turnLive === false;
  const active = launching || isThreadStatusActive(thread.status) && !inactiveByWorkbenchState && !heldQuestionnaire;
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
        ) : null}
        {canCompact ? (
          <button
            type="button"
            className="relative isolate inline-flex h-8 items-center gap-2 rounded-full px-2.5 font-medium text-fg/muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-fg/muted"
            disabled={compactDisabled}
            title={compactTitle}
            aria-label={compactTitle}
            onClick={() => {
              if (compactDisabled) {
                return;
              }

              setError("");
              setIsRequestingCompaction(true);
              void onCompactThread()
                .catch((compactError) => {
                  setError(compactError instanceof Error ? compactError.message : "Unable to compact context.");
                })
                .finally(() => {
                  setIsRequestingCompaction(false);
                });
            }}
          >
            {isCompacting ? <WorkbenchSpinningBorder radius="1rem" /> : null}
            <CompactIcon size={16} />
            <span>{isCompacting ? "Compacting" : "Compact"}</span>
            <HoldConfirmationRail holding={sendHolding} progress={{ style: holdProgressStyle(sendHolding, COMPACT_SEND_HOLD_MS) }} />
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="mt-1 mb-0 text-danger">{error}</p>
      ) : null}
    </div>
  );
}
