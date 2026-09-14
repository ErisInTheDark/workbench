/*
 * Exports:
 * - BrowserNavigationTarget: minimal browser boundary used by the navigation store. Keywords: History API, test seam.
 * - installBrowserNavigationEvents: publish push and replace navigation through one browser event. Keywords: History API, lifecycle.
 * - subscribeBrowserNavigation: subscribe to push, replace, back, and forward navigation. Keywords: History API, popstate.
 * - usePathname/useSearchParams: browser history hooks for route consumers. Keywords: React, route, history.
 */
import { useMemo, useSyncExternalStore } from "react";

const NAVIGATION_EVENT = "workbench:navigation";

export interface BrowserNavigationTarget {
  addEventListener(type: string, listener: EventListener): void;
  dispatchEvent(event: Event): boolean;
  history: {
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  location: {
    pathname: string;
    search: string;
  };
  removeEventListener(type: string, listener: EventListener): void;
}

function currentWindow(): BrowserNavigationTarget {
  return window;
}

export function installBrowserNavigationEvents(target: BrowserNavigationTarget = currentWindow()) {
  const originalPushState = target.history.pushState;
  const originalReplaceState = target.history.replaceState;

  const publishAfter = (operation: typeof originalPushState) => function (
    this: BrowserNavigationTarget["history"],
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ) {
    operation.call(this, data, unused, url);
    target.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const installedPushState = publishAfter(originalPushState);
  const installedReplaceState = publishAfter(originalReplaceState);
  target.history.pushState = installedPushState;
  target.history.replaceState = installedReplaceState;

  return () => {
    if (target.history.pushState === installedPushState) target.history.pushState = originalPushState;
    if (target.history.replaceState === installedReplaceState) target.history.replaceState = originalReplaceState;
  };
}

export function subscribeBrowserNavigation(
  listener: () => void,
  target: BrowserNavigationTarget = currentWindow(),
) {
  target.addEventListener(NAVIGATION_EVENT, listener);
  target.addEventListener("popstate", listener);
  return () => {
    target.removeEventListener(NAVIGATION_EVENT, listener);
    target.removeEventListener("popstate", listener);
  };
}

function pathnameSnapshot() {
  return currentWindow().location.pathname || "/";
}

function searchSnapshot() {
  return currentWindow().location.search;
}

export function usePathname() {
  return useSyncExternalStore(subscribeBrowserNavigation, pathnameSnapshot, () => "/");
}

export function useSearchParams() {
  const search = useSyncExternalStore(subscribeBrowserNavigation, searchSnapshot, () => "");
  return useMemo(() => new URLSearchParams(search), [search]);
}
