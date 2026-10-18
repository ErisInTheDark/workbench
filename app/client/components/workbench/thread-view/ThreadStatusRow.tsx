/*
 * Exports:
 * - ThreadStatusPanel: one status-row control: its segmented pill and the panel it opens.
 * - ThreadStatusAttention: the panel an idle thread wants open, keyed so each change opens it once.
 * - threadStatusSegmentClassName: the default pill segment look, for segments that extend it.
 * - default ThreadStatusRow: a thread's persistent status row; its live title (or a leading notice) and each segmented pill open one shared, animated panel area. Narrow rows hide inline content in favour of narrow-only pills.
 */
"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import IconButton from "../../ui/IconButton";
import SurfacePanels from "./SurfacePanels";
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

export interface ThreadStatusAttention {
  key: string;
  panel: string;
}

/** Who opened the panel: an auto-opened panel yields as soon as its thread gets busy, a user-opened one stays. */
type OpenPanel = { id: string; openedBy: "attention" | "user" };

const LIVE = "live";

// Segments sit close together; only the pill's outer edges keep the full inset.
export const threadStatusSegmentClassName = `
  gap-1 px-1 first:pl-2 last:pr-2 text-[0.74rem] font-semibold tabular-nums
  @max-[32rem]/status:(px-0.5 first:pl-1.5 last:pr-1.5)
`;
/** An open panel's control keeps its hover chrome, so it reads as the thing that closes it. */
const pressedControlClassName = "!border-[color-mix(in_srgb,var(--text)_18%,transparent)] !bg-[color-mix(in_srgb,var(--text)_5%,transparent)]";

export default function ThreadStatusRow({ attention = null, busy = false, inline, leading = null, live, panels = [] }: {
  /** While idle, opens its panel on mount, whenever its key changes, and again once the thread goes idle. */
  attention?: ThreadStatusAttention | null;
  /** A busy thread opens panels only by user action, and closes the ones attention opened. */
  busy?: boolean;
  /** Wide rows only, just left of the pills, such as the thread's active skill pills. */
  inline?: ReactNode;
  /** Fills the title slot while nothing is live, opening its panel. */
  leading?: { content: ReactNode; panel: string } | null;
  live: ThreadLiveActivityView | null;
  panels?: readonly ThreadStatusPanel[];
}) {
  const panelsId = useId();
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  // Panels mount on first opening and stay while the row is open, so switching keeps edits in progress.
  const [mounted, setMounted] = useState<readonly string[]>([]);
  // The live panel belongs to one turn; mounting waits for its first opening.
  const [mountedLiveKey, setMountedLiveKey] = useState<string | null>(null);
  const liveKey = live?.key ?? null;
  const attentionKey = attention?.key ?? null;
  const attentionPanel = attention?.panel ?? null;
  const panelId = panel?.id ?? null;
  useEffect(() => {
    setPanel(current => current?.id === LIVE ? null : current);
  }, [liveKey]);
  useEffect(() => {
    if (busy) setPanel(current => current?.openedBy === "attention" ? null : current);
    else if (attentionKey && attentionPanel) setPanel({ id: attentionPanel, openedBy: "attention" });
  }, [attentionKey, attentionPanel, busy]);
  useEffect(() => {
    if (panelId === LIVE && liveKey) setMountedLiveKey(liveKey);
    else if (panelId !== null) setMounted(current => current.includes(panelId) ? current : [...current, panelId]);
  }, [liveKey, panelId]);

  const visiblePanels = panels.filter(({ segments }) => segments.length);
  if (!live && !leading && !visiblePanels.length && !inline) return null;
  const activePanel = panelId === LIVE ? (live ? LIVE : null) : visiblePanels.some(({ id }) => id === panelId) ? panelId : null;
  const toggle = (next: string) => setPanel(current => current?.id === next ? null : { id: next, openedBy: "user" });
  const closeLive = () => setPanel(current => current?.id === LIVE ? null : current);

  return (
    <div className="@container/status py-4">
      {/* The live panel deliberately closes once scrolled out of view; other panels keep any edit in progress. */}
      <ThreadMeasuredContent onHidden={closeLive}>
        <>
          <div className="flex min-w-0 items-center gap-2 py-1.5 @max-[32rem]/status:gap-0.5">
            {live || leading ? (
              <button
                aria-controls={panelsId}
                aria-expanded={activePanel === (live ? LIVE : leading?.panel)}
                className="
                  flex min-w-0 flex-1 cursor-pointer items-center text-left text-[0.92em] font-medium leading-[1.6] text-fg/muted
                  transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none
                "
                onClick={() => toggle(live ? LIVE : leading!.panel)}
                type="button"
              >
                <span
                  aria-live="polite"
                  className={`
                    flex h-8 min-w-0 items-center overflow-hidden rounded-full border border-transparent px-2 transition
                    ${activePanel === LIVE ? `${pressedControlClassName} text-text` : ""}
                  `}
                >
                  {live ? live.title : leading!.content}
                </span>
              </button>
            ) : <span className="flex-1" />}
            {inline ? <span className="flex max-w-[60%] shrink-0 items-center @max-[32rem]/status:hidden">{inline}</span> : null}
            {visiblePanels.length ? (
              <span className="flex shrink-0 items-center gap-1 @max-[32rem]/status:gap-0.5">
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
          {live || visiblePanels.length ? (
            // Panels grow to their content; only the streaming live terminal keeps a fixed height to scroll within.
            <SurfacePanels
              activeKey={activePanel}
              className="min-w-0 overflow-hidden rounded-[0.8rem] border border-fg-alpha/16 bg-fg/3"
              id={panelsId}
              onClosed={() => setMounted([])}
            >
              {live ? (
                <SurfacePanels.Panel active={activePanel === LIVE} className="min-h-0 h-[min(100vh,24rem)]">
                  {mountedLiveKey === live.key || activePanel === LIVE ? live.renderBody(activePanel === LIVE) : null}
                </SurfacePanels.Panel>
              ) : null}
              {visiblePanels.map(({ id, render }) => mounted.includes(id) || activePanel === id ? (
                <SurfacePanels.Panel active={activePanel === id} className="min-h-0" data-thread-status-panel={id} key={id}>
                  {render()}
                </SurfacePanels.Panel>
              ) : null)}
            </SurfacePanels>
          ) : null}
        </>
      </ThreadMeasuredContent>
    </div>
  );
}
