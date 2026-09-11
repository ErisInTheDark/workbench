/*
 * Exports:
 * - default ThreadComposerRibbon: flush profile triggers and direct Custom profile sliders.
 */
"use client";

import { useRef } from "react";
import { BotIcon, ZapIcon } from "../workbench-icons";
import WorkbenchPressDragSlider from "../WorkbenchPressDragSlider";
import { formatProfileContext, profileContextColour, profileEffortColour } from "./ThreadProfileEditor";

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ThreadComposerRibbon({
  agentLabel,
  currentReasoningEffort,
  isFastModeEnabled,
  isProfilePanelOpen,
  modelLabel,
  modelId,
  onAgentOpen,
  onFastModeToggle,
  onModelOpen,
  onProfileOpen,
  onReasoningEffortChange,
  supportedReasoningEfforts,
  context,
  onContextChange,
  profileLabel,
  selectedProfileLabel = null,
  showsFastModeControl,
  showsProfileControl = true,
  showsReasoningEffortControl,
}: {
  agentLabel: string;
  currentReasoningEffort: string | null;
  isFastModeEnabled: boolean;
  isProfilePanelOpen: boolean;
  modelLabel: string;
  modelId: string | null;
  onAgentOpen: (trigger: HTMLElement, ribbon: HTMLElement) => void;
  onFastModeToggle: () => void;
  onModelOpen: (trigger: HTMLElement, ribbon: HTMLElement) => void;
  onProfileOpen: (trigger: HTMLElement, ribbon: HTMLElement) => void;
  onReasoningEffortChange: (effort: string) => void;
  supportedReasoningEfforts: string[];
  context: { value: number; defaultTokens: number; maximumTokens: number } | null;
  onContextChange: (tokens: number) => void;
  profileLabel: string;
  selectedProfileLabel?: string | null;
  showsFastModeControl: boolean;
  showsProfileControl?: boolean;
  showsReasoningEffortControl: boolean;
}) {
  const ribbon = useRef<HTMLDivElement>(null);
  return (
    <div ref={ribbon} className="inline-flex min-w-0 max-w-full items-center text-[0.78em] font-medium text-text [&>span[aria-hidden]]:h-4 [&>span[aria-hidden]]:shrink-0">
      {showsProfileControl ? <><button
        type="button"
        aria-label={`Composer profile: ${profileLabel}`}
        aria-pressed={isProfilePanelOpen}
        className={joinClasses(
          "relative isolate inline-flex min-w-0 items-center justify-center gap-2 bg-transparent px-2.5 py-2 transition before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft",
          isProfilePanelOpen ? "text-text" : "text-muted hover:text-text",
        )}
        title={`Composer profile: ${profileLabel}`}
        onClick={(event) => { if (ribbon.current) onProfileOpen(event.currentTarget, ribbon.current); }}
      >
        <BotIcon className="size-4.5 shrink-0" />
        {selectedProfileLabel ? <span className="truncate font-semibold">{selectedProfileLabel}</span> : null}
      </button>
      {!selectedProfileLabel ? <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" /> : null}</> : null}
      {!selectedProfileLabel ? <>
      <button
        type="button"
        className="relative isolate min-w-0 truncate bg-transparent px-2.5 py-2 transition before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
        title={modelLabel}
        onClick={(event) => { if (ribbon.current) onModelOpen(event.currentTarget, ribbon.current); }}
      >
        {modelLabel}
      </button>
      {context ? <>
        <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
        <WorkbenchPressDragSlider key={`${modelId}:context`} label="Context window" min={context.defaultTokens} max={context.maximumTokens} step={1000} value={context.value} format={formatProfileContext} colour={profileContextColour} onChange={onContextChange} />
      </> : null}
      {showsReasoningEffortControl && supportedReasoningEfforts.length ? (
        <>
          <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
          <WorkbenchPressDragSlider key={`${modelId}:effort`} label="Reasoning effort" min={0} max={supportedReasoningEfforts.length - 1} step={1} value={Math.max(0, supportedReasoningEfforts.indexOf(currentReasoningEffort ?? ""))} valueText={currentReasoningEffort ?? "Default"} format={(index) => supportedReasoningEfforts[index] ?? ""} colour={profileEffortColour} onChange={(index) => onReasoningEffortChange(supportedReasoningEfforts[index])} />
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
              "relative isolate inline-flex shrink-0 items-center justify-center bg-transparent px-2.5 py-2 transition before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft",
              isFastModeEnabled
                ? "text-text"
                : "text-muted",
            )}
            title={isFastModeEnabled ? "Fast mode is on" : "Fast mode is off"}
            onClick={onFastModeToggle}
          >
            <ZapIcon className="size-4.5" />
          </button>
        </>
      ) : null}
      <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
      <button
        type="button"
        className="relative isolate min-w-0 truncate bg-transparent px-2.5 py-2 transition before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
        title={agentLabel}
        onClick={(event) => { if (ribbon.current) onAgentOpen(event.currentTarget, ribbon.current); }}
      >
        {agentLabel}
      </button>
      </> : null}
    </div>
  );
}
