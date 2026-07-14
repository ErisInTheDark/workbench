/*
 * Exports:
 * - default ThreadSubagentWaitItem: render named subagent wait outcomes with cumulative live timing, tabs, completed Markdown, or failure details. Keywords: workbench, thread, subagent, wait, duration, tabs, preview, timeout.
 */
"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import type { ThreadPayload, WorkbenchSubagentSummary } from "../../../lib/types";
import type { ThreadCommandExecutionOutcome } from "../../../lib/workbench/thread/thread-command-matchers";

import ThreadAgentName from "./ThreadAgentName";
import ThreadDisclosure, { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadPreviewFrame from "./ThreadPreviewFrame";
import ThreadSummaryText from "./ThreadSummaryText";

interface ThreadSubagentWaitEntry {
  content?: ReactNode;
  subagent?: WorkbenchSubagentSummary | null;
  thread?: ThreadPayload | null;
  threadId: string;
}

export default function ThreadSubagentWaitItem ({
  disclosureContent,
  activeStartedAtMs,
  durationMs,
  entries,
  exitCode,
  outcome,
}: {
  disclosureContent?: ReactNode;
  activeStartedAtMs?: number | null;
  durationMs?: number | null;
  entries: ThreadSubagentWaitEntry[];
  exitCode?: number | null;
  outcome: ThreadCommandExecutionOutcome;
}) {
  const tabSetId = useId();
  const [selectedThreadId, setSelectedThreadId] = useState(entries[0]?.threadId ?? "");
  const selectedEntry = entries.find((entry) => entry.threadId === selectedThreadId) ?? entries[0] ?? null;
  const multiplexed = entries.length > 1;
  const active = outcome === "inProgress";
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    if (!active || activeStartedAtMs === null || activeStartedAtMs === undefined) {
      return;
    }

    const updateNow = () => setNowMs(Date.now());
    updateNow();
    const intervalId = window.setInterval(updateNow, 1_000);
    return () => window.clearInterval(intervalId);
  }, [active, activeStartedAtMs]);
  const visibleDurationMs = active
    && activeStartedAtMs !== null
    && activeStartedAtMs !== undefined
    && durationMs !== null
    && durationMs !== undefined
    && nowMs !== null
      ? durationMs + Math.max(0, nowMs - activeStartedAtMs)
      : durationMs;
  const showFailureExit = outcome === "failed" && exitCode !== null && exitCode !== undefined && exitCode !== 0;
  const showDuration = visibleDurationMs !== null && visibleDurationMs !== undefined;
  if (!selectedEntry) return null;
  const summary = (
    <span>
      {outcome === "inProgress" ? "Waiting for "
        : outcome === "timedOut" ? "Timed out waiting for "
        : outcome === "failed" ? "Failed waiting for "
        : outcome === "declined" ? "Declined waiting for "
        : "Waited for "}
      {entries.map((entry, index) => (
        <span key={entry.threadId}>
          {index === 0
            ? null
            : index === entries.length - 1
              ? entries.length === 2 ? " and " : ", and "
              : ", "}
          <ThreadAgentName
            fallbackKey={entry.threadId}
            subagent={entry.subagent}
            thread={entry.thread}
          />
        </span>
      ))}
      {showFailureExit || showDuration ? (
        <span className="ml-2 text-[0.84em] text-muted">
          {showFailureExit ? <ThreadSummaryText text={`exit ${exitCode}`} /> : null}
          {showFailureExit && showDuration ? <span> | </span> : null}
          {showDuration ? <ThreadDurationText durationMs={visibleDurationMs} /> : null}
        </span>
      ) : null}
    </span>
  );

  if (outcome === "completed" && !disclosureContent) {
    return (
      <ThreadDisclosureStaticRow
        summary={summary}
        summaryClassName="text-[0.92em] leading-[1.6] text-muted"
      />
    );
  }

  return (
    <ThreadDisclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      defaultOpen={active}
      summary={summary}
      summaryClassName="text-[0.92em] leading-[1.6] text-muted"
    >
      {disclosureContent ? disclosureContent : multiplexed && active ? (
        <>
          <div
            aria-label="Watched subagents"
            className="explorer-scrollbar -mb-px flex max-w-full gap-3 overflow-x-auto"
            role="tablist"
          >
            {entries.map((entry, index) => {
              const selected = entry.threadId === selectedEntry.threadId;
              const tabId = `${tabSetId}-tab-${index}`;
              const panelId = `${tabSetId}-panel`;
              return (
                <button
                  aria-controls={panelId}
                  aria-selected={selected}
                  className={`shrink-0 border-b-2 px-1 py-2 text-[0.84rem] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft${selected
                    ? " border-text text-text"
                    : " border-transparent text-muted hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text"}`}
                  id={tabId}
                  key={entry.threadId}
                  onClick={() => setSelectedThreadId(entry.threadId)}
                  role="tab"
                  type="button"
                >
                  <ThreadAgentName fallbackKey={entry.threadId} subagent={entry.subagent} thread={entry.thread} />
                </button>
              );
            })}
          </div>
          <div
            aria-labelledby={`${tabSetId}-tab-${entries.indexOf(selectedEntry)}`}
            id={`${tabSetId}-panel`}
            role="tabpanel"
          >
            {selectedEntry.content ? (
              <ThreadPreviewFrame
                contentClassName="px-4 py-3 md:px-12"
                contentPadding="none"
                height="22rem"
                scale={0.9}
              >
                {selectedEntry.content}
              </ThreadPreviewFrame>
            ) : null}
          </div>
        </>
      ) : active && selectedEntry.content ? (
        <ThreadPreviewFrame
          contentClassName="px-4 py-3 md:px-12"
          contentPadding="none"
          height="22rem"
          scale={0.9}
        >
          {selectedEntry.content}
        </ThreadPreviewFrame>
      ) : null}
    </ThreadDisclosure>
  );
}
