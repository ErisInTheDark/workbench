/*
 * Exports:
 * - default ThreadComposerRibbon: flush profile, provider and model triggers plus direct Custom profile sliders.
 */
"use client";

import { useRef, type ReactNode } from "react";
import { ZapIcon } from "../workbench-icons";
import WorkbenchPressDragSlider from "../WorkbenchPressDragSlider";
import { formatProfileContext, profileContextColour, profileEffortColour } from "./ThreadProfileEditor";

function joinClasses(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function ThreadComposerRibbon({
  agentLabel,
  currentReasoningEffort,
  isFastModeEnabled,
  modelLabel,
  modelId,
  onAgentOpen,
  onFastModeToggle,
  onModelOpen,
  onProviderOpen,
  onReasoningEffortChange,
  supportedReasoningEfforts,
  context,
  onContextChange,
  profileControl,
  providerLabel = "",
  selectedProfileLabel = null,
  targetControl,
  showsFastModeControl,
  showsProfileControl = true,
  showsProviderControl = false,
  showsReasoningEffortControl,
}: {
  agentLabel: string;
  currentReasoningEffort: string | null;
  isFastModeEnabled: boolean;
  modelLabel: string;
  modelId: string | null;
  onAgentOpen: (trigger: HTMLElement, ribbon: HTMLElement) => void;
  onFastModeToggle: () => void;
  onModelOpen: (trigger: HTMLElement, ribbon: HTMLElement) => void;
  onProviderOpen?: (trigger: HTMLElement, ribbon: HTMLElement) => void;
  onReasoningEffortChange: (effort: string) => void;
  supportedReasoningEfforts: string[];
  context: { value: number; defaultTokens: number; maximumTokens: number } | null;
  onContextChange: (tokens: number) => void;
  profileControl?: ReactNode;
  providerLabel?: string;
  selectedProfileLabel?: string | null;
  targetControl?: ReactNode;
  showsFastModeControl: boolean;
  showsProfileControl?: boolean;
  showsProviderControl?: boolean;
  showsReasoningEffortControl: boolean;
}) {
  const ribbon = useRef<HTMLDivElement>(null);
  return (
    <div ref={ribbon} className="inline-flex min-w-0 max-w-full items-center overflow-x-auto whitespace-nowrap text-[0.78em] font-medium text-text *:shrink-0 [&>span[aria-hidden]]:h-4">
      {targetControl ? <>{targetControl}<span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" /></> : null}
      {showsProfileControl && profileControl ? <>{profileControl}
      {!selectedProfileLabel ? <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" /> : null}</> : null}
      {!selectedProfileLabel ? <>
      {showsProviderControl && onProviderOpen ? <>
        <button
          type="button"
          className="enabled:cursor-pointer relative isolate min-w-0 truncate bg-transparent px-2.5 py-2 transition before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
          title={providerLabel}
          onClick={(event) => { if (ribbon.current) onProviderOpen(event.currentTarget, ribbon.current); }}
        >
          {providerLabel}
        </button>
        <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
      </> : null}
      <button
        type="button"
        className="enabled:cursor-pointer relative isolate min-w-0 truncate bg-transparent px-2.5 py-2 transition before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
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
              "enabled:cursor-pointer",
              "relative isolate inline-flex shrink-0 items-center justify-center bg-transparent px-2.5 py-2 transition before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft",
              isFastModeEnabled
                ? "text-text"
                : "text-fg/muted",
            )}
            title={isFastModeEnabled ? "Fast mode is on" : "Fast mode is off"}
            onClick={onFastModeToggle}
          >
            <ZapIcon size={18} />
          </button>
        </>
      ) : null}
      <span className="w-px bg-[color-mix(in_srgb,var(--text)_10%,transparent)]" aria-hidden="true" />
      <button
        type="button"
        className="enabled:cursor-pointer relative isolate min-w-0 truncate bg-transparent px-2.5 py-2 transition before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"
        title={agentLabel}
        onClick={(event) => { if (ribbon.current) onAgentOpen(event.currentTarget, ribbon.current); }}
      >
        {agentLabel}
      </button>
      </> : null}
    </div>
  );
}
