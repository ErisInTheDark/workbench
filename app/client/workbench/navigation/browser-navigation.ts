/*
 * Exports:
 * - BrowserNavigationTarget: minimal browser boundary used by the navigation store and link interception.
 * - installBrowserNavigationEvents: publish push and replace navigation through one browser event.
 * - installBrowserLinkNavigation: turn plain clicks on in-app route links into history pushes instead of document loads.
 * - subscribeBrowserNavigation: subscribe to push, replace, back, and forward navigation.
 * - usePathname/useSearchParams: browser history hooks for route consumers.
 */
import { useMemo, useSyncExternalStore } from "react";
import { WORKBENCH_ROUTE_MARKER } from "workbench-shared/workbench/navigation/workbench-route";

const NAVIGATION_EVENT = "workbench:navigation";

export interface BrowserNavigationTarget {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  dispatchEvent(event: Event): boolean;
  history: {
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
  };
  location: {
    origin: string;
    pathname: string;
    search: string;
  };
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions): void;
}

interface LinkClick {
  altKey: boolean;
  button: number;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  preventDefault(): void;
}

interface RouteLink {
  href: string;
  target: string;
  hasAttribute(name: string): boolean;
}

function currentWindow(): BrowserNavigationTarget {
  return window;
}

function closestLink(target: EventTarget | null): RouteLink | null {
  const closest = (target as { closest?: unknown } | null)?.closest;
  return typeof closest === "function" ? closest.call(target, "a[href]") as RouteLink | null : null;
}

/** Workbench routes are `/` or carry the route marker segment; other same-origin paths are assets or apis. */
function isWorkbenchRoutePath(pathname: string) {
  return pathname === "/" || pathname.split("/").includes(WORKBENCH_ROUTE_MARKER);
}

/**
 * Capture arms every eligible click, so a link stays ours even when a component stops the click bubbling (tooltips,
 * popovers, row actions). The last moment the click is still ours (window bubble, or that `stopPropagation`) decides:
 * unless a component called `preventDefault`, the document load is blocked and the href pushed.
 */
export function installBrowserLinkNavigation(target: BrowserNavigationTarget = currentWindow()) {
  const armed = new WeakMap<Event, () => void>();
  const arm = (event: Event) => {
    const click = event as unknown as LinkClick;
    if (click.defaultPrevented || click.button !== 0
      || click.altKey || click.ctrlKey || click.metaKey || click.shiftKey) return;
    const link = closestLink(click.target);
    if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
    const url = new URL(link.href, target.location.origin);
    if (url.origin !== target.location.origin || !isWorkbenchRoutePath(url.pathname)) return;
    let decided = false;
    const decide = () => {
      if (decided) return;
      decided = true;
      if (event.defaultPrevented) return;
      event.preventDefault();
      const href = `${url.pathname}${url.search}${url.hash}`;
      if (href !== `${target.location.pathname}${target.location.search}`) {
        target.history.pushState({ workbench: true }, "", href);
      }
    };
    armed.set(event, decide);
    for (const method of ["stopPropagation", "stopImmediatePropagation"] as const) {
      const stop = event[method].bind(event);
      Object.defineProperty(event, method, { configurable: true, value: () => { stop(); decide(); } });
    }
  };
  const settle = (event: Event) => armed.get(event)?.();
  target.addEventListener("click", arm, { capture: true });
  target.addEventListener("click", settle);
  return () => {
    target.removeEventListener("click", arm, { capture: true });
    target.removeEventListener("click", settle);
  };
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
