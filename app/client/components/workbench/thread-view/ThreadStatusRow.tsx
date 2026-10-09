/*
 * Exports:
 * - default ThreadStatusRow: a thread's persistent status row; its live title opens the live-turn panel and its goal/todo pill (led by active skill pills) opens the todo panel, sliding between the two.
 */
"use client";

import { useEffect, useId, useState, type ReactNode } from "react";

import WorkbenchIconButton from "../WorkbenchIconButton";
import { ClipboardListIcon, FlagFilledIcon, FlagIcon } from "../workbench-icons";
import ThreadMeasuredContent from "./ThreadMeasuredContent";
import type { ThreadLiveActivityView } from "./use-thread-live-activity";

type Panel = "live" | "todos";

/** One grid cell holds both panels; the inactive one leaves flow and slides out toward its own side. */
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
const todoSlideClassName = "transform-[translateX(1.5rem)] starting:data-[active=true]:transform-[translateX(1.5rem)]";

export default function ThreadStatusRow({ live, skills, todos }: {
  live: ThreadLiveActivityView | null;
  /** Sits just left of the goal/todo pill, such as the thread's active skill pills. */
  skills?: ReactNode;
  /** Absent where a thread has no goal or todos to manage, such as standalone renders. */
  todos?: { goalSet: boolean; count: number; renderPanel(): ReactNode } | null;
}) {
  const panelsId = useId();
  const [panel, setPanel] = useState<Panel | null>(null);
  // The live panel belongs to one turn; mounting waits for its first opening.
  const [mountedLiveKey, setMountedLiveKey] = useState<string | null>(null);
  const liveKey = live?.key ?? null;
  useEffect(() => {
    setPanel(current => current === "live" ? null : current);
  }, [liveKey]);
  useEffect(() => {
    if (panel === "live" && liveKey) setMountedLiveKey(liveKey);
  }, [liveKey, panel]);

  if (!live && !todos) return null;
  const open = panel !== null;
  const toggle = (next: Panel) => setPanel(current => current === next ? null : next);
  // During a live turn both panels share one height, so swapping never makes the row hop.
  const panelHeight = live ? "h-[min(100vh,24rem)]" : "max-h-[min(100vh,24rem)]";

  return (
    <div className="py-4">
      {/* The live panel deliberately closes once scrolled out of view; the todo panel keeps any edit in progress. */}
      <ThreadMeasuredContent onHidden={() => setPanel(current => current === "live" ? null : current)}>
        <div className={`
          overflow-hidden rounded-[0.8rem] border transition-colors
          ${open ? "border-fg-alpha/16 bg-fg/3" : "border-transparent"}
        `}>
          <div className={`flex min-w-0 items-center gap-2 px-3 py-1.5 ${open ? "border-b border-fg-alpha/16" : ""}`}>
            {live ? (
              <button
                aria-controls={panelsId}
                aria-expanded={panel === "live"}
                className="
                  flex min-w-0 flex-1 cursor-pointer items-center py-0.5 text-left text-[0.92em] font-medium leading-[1.6] text-fg/muted
                  transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none
                "
                onClick={() => toggle("live")}
                type="button"
              >
                <span aria-live="polite" className="flex min-w-0 overflow-hidden">{live.title}</span>
              </button>
            ) : <span className="flex-1" />}
            {skills ? <span className="flex max-w-[60%] shrink-0 items-center">{skills}</span> : null}
            {todos ? (
              <WorkbenchIconButton
                aria-controls={panelsId}
                aria-expanded={panel === "todos"}
                aria-pressed={panel === "todos"}
                display="hover-border"
                label={panel === "todos" ? "Hide goal and todos" : "Show goal and todos"}
                onClick={() => toggle("todos")}
                shape="pill"
                size="small"
              >
                <span>{todos.goalSet ? <FlagFilledIcon size={14} /> : <FlagIcon size={14} />}</span>
                <span className={todos.count ? "gap-1 pr-2.5 pl-[9px]" : ""}>
                  <ClipboardListIcon size={14} />
                  {todos.count ? <span className="text-[0.74rem] font-semibold tabular-nums">{todos.count}</span> : null}
                </span>
              </WorkbenchIconButton>
            ) : null}
          </div>
          {open ? (
            // A zero-minimum row keeps content from growing the cell, so panel scrollers stay bounded.
            <div className={`relative grid min-w-0 grid-rows-[minmax(0,1fr)] ${panelHeight}`} id={panelsId}>
              {live ? (
                <div
                  aria-hidden={panel !== "live"}
                  className={`${panelClassName} ${liveSlideClassName}`}
                  data-active={panel === "live" ? "true" : "false"}
                  inert={panel !== "live"}
                >
                  {mountedLiveKey === live.key || panel === "live" ? live.renderBody(panel === "live") : null}
                </div>
              ) : null}
              {todos ? (
                <div
                  aria-hidden={panel !== "todos"}
                  className={`${panelClassName} ${todoSlideClassName} max-h-[min(100vh,24rem)] overflow-y-auto overscroll-contain`}
                  data-active={panel === "todos" ? "true" : "false"}
                  inert={panel !== "todos"}
                >
                  {todos.renderPanel()}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </ThreadMeasuredContent>
    </div>
  );
}
