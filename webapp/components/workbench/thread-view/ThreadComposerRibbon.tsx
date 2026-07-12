/*
 * Exports:
 * - default ThreadComposerRibbon: render profile, model, effort, fast-mode, and agent controls as one composer ribbon. Keywords: thread, composer, ribbon, profile, model, agent.
 */
"use client";

import { BlocksIcon } from "../workbench-icons";

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function LightningBoltIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4.5 w-4.5" aria-hidden="true">
      <path d="M11.25 1.9L4.75 10.7h4.55l-.75 7.4 6.7-9h-4.65l.65-7.2z" fill="currentColor" />
    </svg>
  );
}

export default function ThreadComposerRibbon({
  agentLabel,
  currentReasoningEffort,
  isFastModeEnabled,
  isProfilePanelOpen,
  modelLabel,
  onAgentOpen,
  onFastModeToggle,
  onModelOpen,
  onProfileOpen,
  onReasoningEffortCycle,
  profileLabel,
  showsFastModeControl,
  showsProfileControl = true,
  showsReasoningEffortControl,
}: {
  agentLabel: string;
  currentReasoningEffort: string | null;
  isFastModeEnabled: boolean;
  isProfilePanelOpen: boolean;
  modelLabel: string;
  onAgentOpen: () => void;
  onFastModeToggle: () => void;
  onModelOpen: () => void;
  onProfileOpen: () => void;
  onReasoningEffortCycle: (direction: 1 | -1) => void;
  profileLabel: string;
  showsFastModeControl: boolean;
  showsProfileControl?: boolean;
  showsReasoningEffortControl: boolean;
}) {
  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-full border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color-mix(in_srgb,var(--bg)_96%,transparent)] text-[0.78em] font-medium text-text">
      {showsProfileControl ? <><button
        type="button"
        aria-label={`Composer profile: ${profileLabel}`}
        aria-pressed={isProfilePanelOpen}
        className={joinClasses(
          "inline-flex items-center justify-center px-2.5 py-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft",
          isProfilePanelOpen ? "bg-[color-mix(in_srgb,var(--text)_7%,transparent)] text-text" : "text-muted hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:text-text",
        )}
        title={`Composer profile: ${profileLabel}`}
        onClick={onProfileOpen}
      >
        <BlocksIcon className="size-4.5" />
      </button>
      <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" /></> : null}
      <button
        type="button"
        className="px-3 py-2 transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
        onClick={onModelOpen}
      >
        {modelLabel}
      </button>
      {showsReasoningEffortControl && currentReasoningEffort ? (
        <>
          <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
          <button
            type="button"
            className="px-2.5 py-2 capitalize transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
            title="Left click to increase effort. Right click to decrease effort."
            onClick={() => onReasoningEffortCycle(1)}
            onContextMenu={(event) => {
              event.preventDefault();
              onReasoningEffortCycle(-1);
            }}
          >
            {currentReasoningEffort}
          </button>
        </>
      ) : null}
      {showsFastModeControl ? (
        <>
          <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
          <button
            type="button"
            aria-label={isFastModeEnabled ? "Turn fast mode off" : "Turn fast mode on"}
            aria-pressed={isFastModeEnabled}
            className={joinClasses(
              "inline-flex items-center justify-center px-2.5 py-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft",
              isFastModeEnabled
                ? "text-text hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)]"
                : "text-muted opacity-40 hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] hover:opacity-65",
            )}
            title={isFastModeEnabled ? "Fast mode is on" : "Fast mode is off"}
            onClick={onFastModeToggle}
          >
            <LightningBoltIcon />
          </button>
        </>
      ) : null}
      <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
      <button
        type="button"
        className="px-3 py-2 transition hover:bg-[color-mix(in_srgb,var(--text)_4%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
        onClick={onAgentOpen}
      >
        {agentLabel}
      </button>
    </div>
  );
}
