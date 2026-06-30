/*
 * Exports:
 * - default CollaborationRunPanel: render Collaboration auto-run controls, recent runs, active run, and run composer. Keywords: collaboration, runs, auto-run.
 * - Local helpers: format run timestamps and render loading run skeletons. Keywords: collaboration, run history, skeleton.
 */
"use client";

import { useEffect, useRef, type ReactNode } from "react";

import type { ThreadSummary } from "../../../lib/types";
import PrimaryButton from "../PrimaryButton";
import ThreadScrollAnchorController from "../thread-view/ThreadScrollAnchorController";
import ThreadDisclosure from "../thread-view/ThreadDisclosure";
import WorkbenchProgressWheel from "../WorkbenchProgressWheel";

function formatRelativeRunTime(summary: ThreadSummary, now: number) {
  const elapsedSeconds = Math.max(0, Math.floor((now - summary.updatedAt * 1000) / 1000));
  if (elapsedSeconds < 45) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function RunSummarySkeleton () {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2" aria-label="Loading collaborator run">
      <span className="h-3 w-32 rounded-full bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" />
      <span className="h-3 w-14 rounded-full bg-[color-mix(in_srgb,var(--text)_7%,transparent)]" />
    </span>
  );
}

function InlineRunSummarySkeleton () {
  return (
    <span className="ml-1 inline-flex translate-y-[0.08rem] items-center gap-2" aria-label="Loading current collaborator run">
      <span className="h-3 w-28 rounded-full bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" />
      <span className="h-3 w-12 rounded-full bg-[color-mix(in_srgb,var(--text)_7%,transparent)]" />
    </span>
  );
}

function getRunSummaryTitle(summary: ThreadSummary) {
  return summary.name || summary.preview || "Collaborator run";
}

export default function CollaborationRunPanel ({
  activeRunContent,
  autoWakeCountdownMs,
  autoWakeEnabled,
  autoWakeProgressPercent,
  collaboratorComposer,
  collaboratorStatus,
  collaboratorStatusLabel,
  error,
  isAutoWakePaused,
  isAutoWakeToggleDisabled,
  isRunDisabled,
  lastRunMemory,
  recentRunIds,
  selectedRunThreadId,
  summariesById,
  onRunNow,
  onSelectRunThread,
  onToggleAutoRun,
}: {
  activeRunContent: ReactNode;
  autoWakeCountdownMs: number | null;
  autoWakeEnabled: boolean;
  autoWakeProgressPercent: number;
  collaboratorComposer: ReactNode | null;
  collaboratorStatus: "failed" | "hydrating" | "idle" | "running" | "starting";
  collaboratorStatusLabel: string;
  error: string;
  isAutoWakePaused: boolean;
  isAutoWakeToggleDisabled: boolean;
  isRunDisabled: boolean;
  lastRunMemory: string;
  recentRunIds: readonly string[];
  selectedRunThreadId: string;
  summariesById: Map<string, ThreadSummary>;
  onRunNow: () => void;
  onSelectRunThread: (threadId: string) => void;
  onToggleAutoRun: () => void;
}) {
  const isRunning = collaboratorStatus === "running" || collaboratorStatus === "starting";
  const runButtonLabel = isRunning ? "Running..." : recentRunIds.length ? "Run now" : "Start collaborator";
  const historyBottomRef = useRef<HTMLDivElement | null>(null);
  const historyScrollControllerRef = useRef<ReturnType<typeof ThreadScrollAnchorController> | null>(null);
  if (!historyScrollControllerRef.current) {
    historyScrollControllerRef.current = ThreadScrollAnchorController();
  }
  const historyScrollController = historyScrollControllerRef.current;
  const historySignature = recentRunIds.join("\0");
  const selectedRunSummary = selectedRunThreadId ? summariesById.get(selectedRunThreadId) ?? null : null;

  useEffect(() => {
    historyScrollController.resetForThreadSwitch();
    historyScrollController.scrollRootToBottom(historyBottomRef.current);
  }, [historyScrollController, historySignature, selectedRunThreadId]);

  return (
    <section className="min-h-full min-w-0 px-5 py-5 md:px-6">
      <div className="mb-6 border-b border-[color-mix(in_srgb,var(--text)_10%,transparent)] pb-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="m-0 text-[0.78rem] font-medium uppercase tracking-[0.08em] text-muted">Collaborator</p>
            <p className="mt-1 mb-0 text-[0.84rem] leading-5 text-muted">{collaboratorStatusLabel}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
            <button
              type="button"
              aria-pressed={autoWakeEnabled}
              title={isAutoWakePaused ? "Auto-run is paused while the collaborator composer has unsent text." : "Toggle collaborator auto-run"}
              className="inline-flex h-9 items-center gap-2 rounded-full px-2.5 text-[0.82rem] font-medium text-muted transition hover:bg-[color-mix(in_srgb,var(--text)_5%,transparent)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-45"
              disabled={isAutoWakeToggleDisabled}
              onClick={onToggleAutoRun}
            >
              <span
                aria-hidden="true"
                className={`inline-flex size-4 shrink-0 rounded-[0.28rem] border transition${autoWakeEnabled
                  ? " border-[color-mix(in_srgb,var(--text)_40%,transparent)] bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]"
                  : " border-[color-mix(in_srgb,var(--text)_22%,transparent)] bg-transparent"}`}
              />
              <span>{isAutoWakePaused ? "Auto-run paused" : "Auto-run"}</span>
              {autoWakeEnabled && autoWakeCountdownMs !== null ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-muted">
                  <WorkbenchProgressWheel percent={autoWakeProgressPercent} />
                  <span>{Math.ceil(autoWakeCountdownMs / 1000)}s</span>
                </span>
              ) : null}
            </button>
            <PrimaryButton
              type="button"
              disabled={isRunDisabled || isRunning}
              onClick={onRunNow}
            >
              {runButtonLabel}
            </PrimaryButton>
          </div>
        </div>
      </div>
      {recentRunIds.length ? (
        <section className="mb-5 space-y-3">
          <p className="m-0 text-[0.78rem] font-medium uppercase tracking-[0.08em] text-muted">Recent collaborator runs</p>
          <div
            className="explorer-scrollbar max-h-[32rem] space-y-3 overflow-y-auto pr-1"
            data-thread-scroll-target="true"
          >
            {recentRunIds.map((threadId) => {
              const summary = summariesById.get(threadId) ?? null;
              const isOpen = selectedRunThreadId === threadId;
              return (
                <ThreadDisclosure
                  key={threadId}
                  className="py-0.5"
                  contentClassName="-mt-2 pl-[1.6rem] md:pl-[1.85rem]"
                  open={isOpen}
                  onToggle={(event) => {
                    if (event.currentTarget.open) {
                      onSelectRunThread(threadId);
                    }
                  }}
                  summary={(
                    summary ? (
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="max-w-full truncate font-semibold text-text">{getRunSummaryTitle(summary)}</span>
                        <span className="text-[0.78rem] font-normal text-muted">{formatRelativeRunTime(summary, Date.now())}</span>
                      </span>
                    ) : <RunSummarySkeleton />
                  )}
                >
                  {isOpen ? activeRunContent : (
                    <p className="m-0 text-[0.84rem] leading-6 text-muted">Select this run to load its transcript.</p>
                  )}
                </ThreadDisclosure>
              );
            })}
            <div ref={historyBottomRef} aria-hidden="true" />
          </div>
        </section>
      ) : null}
      <details className="mb-4" open={!recentRunIds.length}>
        <summary className="cursor-pointer list-none text-[0.78rem] font-medium uppercase tracking-[0.08em] text-muted marker:hidden">
          Collaborator run details
        </summary>
        <div className="mt-3 space-y-3">
          {selectedRunThreadId ? (
            <p className="m-0 text-[0.84rem] leading-6 text-muted">
              Current run: {selectedRunSummary ? getRunSummaryTitle(selectedRunSummary) : <InlineRunSummarySkeleton />}
            </p>
          ) : null}
          {lastRunMemory ? (
            <details className="pt-1">
              <summary className="cursor-pointer list-none text-[0.78rem] font-medium text-muted marker:hidden">
                Last private run memory
              </summary>
              <p className="mt-2 mb-0 whitespace-pre-wrap text-[0.84rem] leading-6 text-muted">{lastRunMemory}</p>
            </details>
          ) : null}
        </div>
      </details>
      {error ? (
        <p className="mb-3 border-b border-[color-mix(in_srgb,var(--danger)_28%,transparent)] pb-3 text-[0.84rem] leading-5 text-danger">
          {error}
        </p>
      ) : null}
      {collaboratorComposer}
    </section>
  );
}
