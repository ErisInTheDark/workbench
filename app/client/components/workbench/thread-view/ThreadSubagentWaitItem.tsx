/*
 * Exports:
 * - default ThreadSubagentWaitItem: render user-controlled wait details with cumulative timing, tabs, bottom-pinned live activity, outcomes, and failures.
 */
"use client";

import { useId, useState, type ReactNode } from "react";

import type { ThreadCommandExecutionOutcome } from "../../../workbench/thread/thread-command-matchers";

import ThreadAgentName from "./ThreadAgentName";
import ThreadAgentNameList, { type ThreadAgentNameListEntry } from "./ThreadAgentNameList";
import Disclosure, { DisclosureStaticRow } from "../../ui/Disclosure";
import ThreadDurationText from "./ThreadDurationText";
import ThreadPreviewFrame from "./ThreadPreviewFrame";
import ThreadSummaryText from "./ThreadSummaryText";
import { useThreadLiveDuration } from "./use-thread-live-duration";
import { GitArcWaitIcon } from "../workbench-icons";
import { stepLabel, stepLabels } from "./thread-step";

const WAIT_LABELS = stepLabels("Waiting for", "Waited for", "Failed waiting for");

interface ThreadSubagentWaitEntry extends ThreadAgentNameListEntry {
  content?: ReactNode;
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
  const [selectedTargetKey, setSelectedTargetKey] = useState(entries[0]?.targetKey ?? "");
  const selectedEntry = entries.find((entry) => entry.targetKey === selectedTargetKey) ?? entries[0] ?? null;
  const multiplexed = entries.length > 1;
  const active = outcome === "inProgress";
  const visibleDurationMs = useThreadLiveDuration(durationMs, active ? activeStartedAtMs : null);
  const showFailureExit = outcome === "failed" && exitCode !== null && exitCode !== undefined && exitCode !== 0;
  const showDuration = visibleDurationMs !== null && visibleDurationMs !== undefined;
  if (!selectedEntry) return null;
  // Open tabs already name every subagent, so the open summary drops the list.
  const tabbed = multiplexed && active && !disclosureContent;
  const namedSummary = (
    <span className={tabbed ? "[details[open]>summary_&]:hidden" : undefined}>
      {stepLabel(WAIT_LABELS, outcome)}{" "}
      <ThreadAgentNameList entries={entries} />
    </span>
  );
  const summary = (
    <span>
      {namedSummary}
      {tabbed ? <span className="hidden [details[open]>summary_&]:inline">Waiting for subagents…</span> : null}
      {showFailureExit || showDuration ? (
        <span className="ml-2 text-[0.84em] text-fg/muted">
          {showFailureExit ? <ThreadSummaryText text={`exit ${exitCode}`} /> : null}
          {showFailureExit && showDuration ? <span> | </span> : null}
          {showDuration ? <ThreadDurationText durationMs={visibleDurationMs} /> : null}
        </span>
      ) : null}
    </span>
  );

  const body = disclosureContent ? disclosureContent : multiplexed && active ? (
        <>
          <div
            aria-label="Watched subagents"
            className="scrollbar-hover-reveal -mb-px flex max-w-full gap-3 overflow-x-auto"
            role="tablist"
          >
            {entries.map((entry, index) => {
              const selected = entry.targetKey === selectedEntry.targetKey;
              const tabId = `${tabSetId}-tab-${index}`;
              const panelId = `${tabSetId}-panel`;
              return (
                <button
                  aria-controls={panelId}
                  aria-selected={selected}
                  className={`shrink-0 border-b-2 px-1 py-2 text-[0.84rem] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft${selected
                    ? " border-text text-text"
                    : " border-transparent text-fg/muted hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text"}`}
                  id={tabId}
                  key={`${entry.targetKey}:${index}`}
                  onClick={() => setSelectedTargetKey(entry.targetKey)}
                  role="tab"
                  type="button"
                >
                  <ThreadAgentName
                    subagent={entry.subagent}
                    thread={entry.thread ?? (entry.fallbackName ? { agentNickname: entry.fallbackName, agentRole: null } : null)}
                  />
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
                anchor="end"
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
          anchor="end"
          contentClassName="px-4 py-3 md:px-12"
          contentPadding="none"
          height="22rem"
          scale={0.9}
        >
          {selectedEntry.content}
        </ThreadPreviewFrame>
      ) : null;

  if (outcome === "completed" && !disclosureContent) {
    return (
      <DisclosureStaticRow
        marker={<GitArcWaitIcon size={16} />}
        summary={summary}
        summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
      />
    );
  }

  return (
    <Disclosure
      className="py-2"
      contentClassName="mt-2 pl-6"
      defaultOpen={active}
      hideChevron
      leading={<GitArcWaitIcon size={16} />}
      summary={summary}
      summaryClassName="text-[0.92em] leading-[1.6] text-fg/muted"
    >
      {body}
    </Disclosure>
  );
}
