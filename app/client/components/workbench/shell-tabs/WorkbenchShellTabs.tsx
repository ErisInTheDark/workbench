/*
 * Exports:
 * - default WorkbenchShellTabs: the shell header's horizontally scrolling tab strip, one tab per open destination.
 */
"use client";

import { useEffect, useRef } from "react";

import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchTabs } from "../../../workbench/navigation/use-workbench-tabs";
import { workbenchTabKinds } from "./workbench-tab-labels";

export default function WorkbenchShellTabs({ className = "", fallback }: {
  className?: string;
  /** Where to go once the last tab closes. */
  fallback: () => WorkbenchRoute | null;
}) {
  const tabs = useWorkbenchTabs(fallback);
  const listRef = useRef<HTMLDivElement>(null);
  const { current, strip } = tabs;
  // Scroll only the strip: scrollIntoView would also scroll the clipped mobile pane track it sits in.
  // The strip can mount before it has a width (a hidden mobile pane) and tabs widen as titles load, so any resize reveals again.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () => {
      const selected = list.querySelector<HTMLElement>("[data-workbench-shell-tab][data-selected=true]");
      if (!selected || !list.clientWidth) return;
      // The positioned strip is each tab's offset parent.
      const start = selected.offsetLeft;
      const end = start + selected.offsetWidth;
      if (start < list.scrollLeft) list.scrollLeft = start;
      else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    for (const tab of list.querySelectorAll("[data-workbench-shell-tab]")) observer.observe(tab);
    return () => observer.disconnect();
  }, [current, strip.tabs.length]);
  return (
    <div
      ref={listRef}
      aria-label="Open tabs"
      className={`
        scrollbar-hover-reveal relative flex min-w-0 items-stretch gap-1 overflow-x-auto overscroll-x-contain
        ${className}
      `}
      role="tablist"
    >
      {strip.tabs.map((tab, position) => {
        const route = tabs.routeFor(tab);
        const Kind = workbenchTabKinds[route.view];
        if (!Kind) return null;
        return (
          <Kind
            key={tab}
            frame={{
              tab,
              href: tabs.hrefFor(tab),
              selected: tab === current,
              preview: position === strip.preview,
              onClose: () => tabs.close(tab),
              onKeepOpen: () => tabs.keepOpen(tab),
            }}
            route={route}
          />
        );
      })}
    </div>
  );
}
