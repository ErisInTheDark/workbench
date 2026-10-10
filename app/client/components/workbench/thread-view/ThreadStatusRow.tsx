/*
 * Exports:
 * - ThreadStatusPanel: one status-row control: its segmented pill and the panel it opens.
 * - threadStatusSegmentClassName: the default pill segment look, for segments that extend it.
 * - default ThreadStatusRow: a thread's persistent status row; its live title (or a leading notice) and each segmented pill open one shared, sliding panel area. Narrow rows hide inline content in favour of narrow-only pills.
 */
"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import IconButton from "../../ui/IconButton";
import ThreadMeasuredContent from "./ThreadMeasuredContent";
import type { ThreadLiveActivityView } from "./use-thread-live-activity";

export interface ThreadStatusPanel {
  id: string;
  label: string;
  /** Pill cells, side by side at the button's height; an empty list hides the control. */
  segments: readonly { key: string; className?: string; content: ReactNode }[];
  /** Replaces the default pressed chrome while this panel is open. */
  pressedClassName?: string;
  /** Shown only on narrow rows, for controls whose wide form is the row's inline content. */
  narrowOnly?: boolean;
  render(): ReactNode;
}

const LIVE = "live";

/** One grid cell holds every panel; inactive ones leave flow and slide out toward their own side. */
const panelClassName = `
  hidden absolute inset-0 col-start-1 row-start-1 min-h-0 min-w-0 overflow-clip opacity-0
  [transition-behavior:allow-discrete]
  [transition:
    opacity 180ms cubic-bezier(0.2, 0, 0, 1),
    transform 240ms cubic-bezier(0.2, 0, 0, 1),
    display 240ms allow-discrete
  ]
  data-[active=true]:(block relative inset-auto opacity-100 transform-[translateX(0)])
  starting:data-[active=true]:opacity-0
  motion-reduce:(transition-none)
`;
const liveSlideClassName = "transform-[translateX(-1.5rem)] starting:data-[active=true]:transform-[translateX(-1.5rem)]";
const controlSlideClassName = "transform-[translateX(1.5rem)] starting:data-[active=true]:transform-[translateX(1.5rem)]";
// Segments sit close together; only the pill's outer edges keep the full inset.
export const threadStatusSegmentClassName = `
  gap-1 px-1 first:pl-2 last:pr-2 text-[0.74rem] font-semibold tabular-nums
  @max-[32rem]/status:(px-0.5 first:pl-1.5 last:pr-1.5)
`;
/** An open panel's control keeps its hover chrome, so it reads as the thing that closes it. */
const pressedControlClassName = "!border-[color-mix(in_srgb,var(--text)_18%,transparent)] !bg-[color-mix(in_srgb,var(--text)_5%,transparent)]";

export default function ThreadStatusRow({ attention = null, inline, leading = null, live, panels = [] }: {
  /** Opens its panel whenever its key changes, such as when a stopped turn leaves proposals to review. */
  attention?: { key: string; panel: string } | null;
  /** Wide rows only, just left of the pills, such as the thread's active skill pills. */
  inline?: ReactNode;
  /** Fills the title slot while nothing is live, opening its panel. */
  leading?: { content: ReactNode; panel: string } | null;
  live: ThreadLiveActivityView | null;
  panels?: readonly ThreadStatusPanel[];
}) {
  const panelsId = useId();
  const [panel, setPanel] = useState<string | null>(null);
  // Panels mount on first opening and stay while the row is open, so switching keeps edits in progress.
  const [mounted, setMounted] = useState<readonly string[]>([]);
  // The live panel belongs to one turn; mounting waits for its first opening.
  const [mountedLiveKey, setMountedLiveKey] = useState<string | null>(null);
  const liveKey = live?.key ?? null;
  const attentionKey = attention?.key ?? null;
  const attentionPanel = attention?.panel ?? null;
  useEffect(() => {
    setPanel(current => current === LIVE ? null : current);
  }, [liveKey]);
  useEffect(() => {
    if (attentionKey && attentionPanel) setPanel(attentionPanel);
  }, [attentionKey, attentionPanel]);
  useEffect(() => {
    if (panel === LIVE && liveKey) setMountedLiveKey(liveKey);
    if (panel === null) setMounted([]);
    else if (panel !== LIVE) setMounted(current => current.includes(panel) ? current : [...current, panel]);
  }, [liveKey, panel]);

  const visiblePanels = panels.filter(({ segments }) => segments.length);
  if (!live && !leading && !visiblePanels.length && !inline) return null;
  // A panel whose control disappeared closes with it.
  const activePanel = panel === LIVE ? (live ? LIVE : null) : visiblePanels.some(({ id }) => id === panel) ? panel : null;
  const open = activePanel !== null;
  const toggle = (next: string) => setPanel(current => current === next ? null : next);

  return (
    <div className="@container/status py-4">
      {/* The live panel deliberately closes once scrolled out of view; other panels keep any edit in progress. */}
      <ThreadMeasuredContent onHidden={() => setPanel(current => current === LIVE ? null : current)}>
        <div className={`
          overflow-hidden rounded-[0.8rem] border transition-colors
          ${open ? "border-fg-alpha/16 bg-fg/3" : "border-transparent"}
        `}>
          <div className={`flex min-w-0 items-center gap-2 px-3 py-1.5 @max-[32rem]/status:(gap-0.5 px-2) ${open ? "border-b border-fg-alpha/16" : ""}`}>
            {live || leading ? (
              <button
                aria-controls={panelsId}
                aria-expanded={activePanel === (live ? LIVE : leading?.panel)}
                className="
                  flex min-w-0 flex-1 cursor-pointer items-center py-0.5 text-left text-[0.92em] font-medium leading-[1.6] text-fg/muted
                  transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none
                "
                onClick={() => toggle(live ? LIVE : leading!.panel)}
                type="button"
              >
                <span aria-live="polite" className="flex min-w-0 overflow-hidden">{live ? live.title : leading!.content}</span>
              </button>
            ) : <span className="flex-1" />}
            {inline ? <span className="flex max-w-[60%] shrink-0 items-center @max-[32rem]/status:hidden">{inline}</span> : null}
            {visiblePanels.length ? (
              <span className="flex shrink-0 items-center">
                {visiblePanels.map(({ id, label, narrowOnly, pressedClassName, segments }) => {
                  const pressed = activePanel === id;
                  const control = (
                    <IconButton
                      aria-controls={panelsId}
                      aria-expanded={pressed}
                      aria-pressed={pressed}
                      className={pressed ? pressedClassName ?? pressedControlClassName : ""}
                      display="hover-border"
                      key={id}
                      label={label}
                      onClick={() => toggle(id)}
                      shape="pill"
                      size="small"
                    >
                      {segments.map(({ className = threadStatusSegmentClassName, content, key }) => (
                        <span className={className} key={key}>{content}</span>
                      ))}
                    </IconButton>
                  );
                  return narrowOnly ? <span className="hidden @max-[32rem]/status:contents" key={id}>{control}</span> : control;
                })}
              </span>
            ) : null}
          </div>
          {open ? (
            // Panels grow to their content; only the streaming live terminal keeps a fixed height to scroll within.
            <div className="relative grid min-w-0" id={panelsId}>
              {live ? (
                <div
                  aria-hidden={activePanel !== LIVE}
                  className={`${panelClassName} ${liveSlideClassName} h-[min(100vh,24rem)]`}
                  data-active={activePanel === LIVE ? "true" : "false"}
                  inert={activePanel !== LIVE}
                >
                  {mountedLiveKey === live.key || activePanel === LIVE ? live.renderBody(activePanel === LIVE) : null}
                </div>
              ) : null}
              {visiblePanels.map(({ id, render }) => mounted.includes(id) || activePanel === id ? (
                <div
                  aria-hidden={activePanel !== id}
                  className={`${panelClassName} ${controlSlideClassName}`}
                  data-active={activePanel === id ? "true" : "false"}
                  data-thread-status-panel={id}
                  inert={activePanel !== id}
                  key={id}
                >
                  {render()}
                </div>
              ) : null)}
            </div>
          ) : null}
        </div>
      </ThreadMeasuredContent>
    </div>
  );
}
