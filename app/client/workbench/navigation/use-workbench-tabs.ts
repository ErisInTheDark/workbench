/*
 * Exports:
 * - WorkbenchTabs: the tab strip with each tab's destination and href, and the close and keep-open actions.
 * - useWorkbenchTabs: read the url tab strip and act on it through the same hrefs links render.
 */
import { useMemo } from "react";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { WorkbenchTabStrip } from "workbench-shared/workbench/navigation/workbench-tabs";
import {
  useWorkbenchNavigate, useWorkbenchNavigationState, useWorkbenchProjectNavigation,
} from "./use-workbench-project-navigation";

export interface WorkbenchTabs {
  readonly strip: WorkbenchTabStrip;
  readonly current: string | undefined;
  routeFor(tab: string): WorkbenchRoute;
  hrefFor(tab: string): string | undefined;
  close(tab: string): void;
  keepOpen(tab: string): void;
}

/** `fallback` names where to go once the last tab closes; the project selection stays as it is. */
export function useWorkbenchTabs(fallback: () => WorkbenchRoute | null): WorkbenchTabs {
  const { current, currentTab, navigation, strip } = useWorkbenchNavigationState();
  const href = useWorkbenchProjectNavigation();
  const navigate = useWorkbenchNavigate();
  return useMemo(() => {
    const focus = (tab: string, next: WorkbenchTabStrip) =>
      navigate(navigation.routeForTab(tab), { replace: true, tab: { strip: next } });
    return {
      strip,
      current: currentTab,
      routeFor: tab => navigation.routeForTab(tab),
      hrefFor: tab => href(navigation.routeForTab(tab)),
      close: (tab) => {
        const closed = WorkbenchTabStrip.close(strip, tab, currentTab ?? null);
        if (closed.focus !== null) {
          focus(closed.focus, closed.strip);
          return;
        }
        const destination = fallback();
        const fallbackTab = destination ? navigation.tabFor(destination, current) : undefined;
        if (destination && fallbackTab !== undefined) {
          navigate(destination, { replace: true, tab: { strip: WorkbenchTabStrip.open(closed.strip, fallbackTab) } });
        }
      },
      keepOpen: tab => { if (currentTab !== undefined) focus(currentTab, WorkbenchTabStrip.pin(strip, tab)); },
    };
  }, [current, currentTab, fallback, href, navigate, navigation, strip]);
}
