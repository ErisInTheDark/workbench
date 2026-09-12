/*
 * Exports:
 * - default ThreadWorkedRun: own SQL work-run visibility, age eligibility and reveal intent.
 */
"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FoldWorkedRunIcon, UnfoldWorkedRunIcon } from "../workbench-icons";
import { ThreadDisclosureStaticRow } from "./ThreadDisclosure";
import ThreadDurationText from "./ThreadDurationText";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";
import { reconcileWorkedRun, revealWorkedRun, workedRunReadyAt, type WorkedRunState } from "./thread-worked-run";

export default function ThreadWorkedRun({ children, count, durationMs, initialInactive, newestActivityAt }: {
  children: ReactNode;
  count: number;
  durationMs: number | null;
  initialInactive: boolean;
  newestActivityAt: number | null;
}) {
  const [state, setState] = useState<WorkedRunState>("expanded");
  const element = useRef<HTMLDivElement>(null);
  const restoreLayout = useRef<(() => void) | null>(null);
  const viewportContext = useThreadScrollViewportContext();
  useLayoutEffect(() => {
    restoreLayout.current?.();
    restoreLayout.current = null;
  }, [state]);
  useEffect(() => {
    const node = element.current;
    const viewport = viewportContext.getViewport();
    if (!node || !viewport) return;
    if (state === "collapsed") {
      const next = reconcileWorkedRun(state, { count, newestActivityAt, initialInactive, above: false, now: Date.now() }, false);
      if (next !== state) {
        if (node.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().top) {
          restoreLayout.current = viewportContext.preserveOffscreenLayout();
        }
        setState(next);
      }
      return;
    }
    if (count < 5) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retired = false;
    const measure = () => {
      if (retired) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const bounds = node.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      if (!viewport.clientHeight || !bounds.height) return;
      const above = bounds.bottom <= view.top;
      const visible = bounds.bottom > view.top && bounds.top < view.bottom;
      const now = Date.now();
      const gate = { count, newestActivityAt, initialInactive, above, now };
      const next = reconcileWorkedRun(state, gate, visible);
      if (next !== state) {
        if (next === "collapsed") restoreLayout.current = viewportContext.preserveOffscreenLayout();
        setState(next);
        return;
      }
      const readyAt = workedRunReadyAt(gate);
      if (state === "expanded" && above && count >= 5 && readyAt !== null && readyAt > now) {
        // User-owned age policy, not a timeout or retry of external work.
        timer = setTimeout(measure, Math.min(readyAt - now, 2_147_483_647));
      }
    };
    const intersection = new IntersectionObserver(measure, { root: viewport, threshold: [0, 1] });
    const resize = new ResizeObserver(measure);
    intersection.observe(node);
    resize.observe(node);
    resize.observe(viewport);
    viewport.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      retired = true;
      if (timer !== null) clearTimeout(timer);
      intersection.disconnect();
      resize.disconnect();
      viewport.removeEventListener("scroll", measure);
    };
  }, [count, initialInactive, newestActivityAt, state, viewportContext]);
  return (
    <div ref={element} className="min-w-0 space-y-2">
      {state === "collapsed" ? (
        <ThreadDisclosureStaticRow
          onClick={() => setState(revealWorkedRun())}
          summary={durationMs === null ? "Worked" : <>Worked for <ThreadDurationText durationMs={durationMs} /></>}
          summaryClassName="text-[0.92em] leading-[1.6]"
          marker={<>
            <FoldWorkedRunIcon className="group-hover/worked:hidden group-focus-visible/worked:hidden" size={18} />
            <UnfoldWorkedRunIcon className="hidden group-hover/worked:block group-focus-visible/worked:block" size={18} />
          </>}
        />
      ) : children}
    </div>
  );
}
