/*
 * Exports:
 * - useWorkbenchRoute: React hook that derives workbench route state from the browser URL and exposes guarded user navigation. Keywords: URL source of truth, external store, popstate, pushState.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  createWorkbenchHref,
  parseWorkbenchRouteFromLocation,
  type WorkbenchRoute,
} from "./workbench-route";

const WORKBENCH_URL_CHANGE_EVENT = "workbench:url-change";
const WORKBENCH_HISTORY_STATE = { workbench: true };

function readLocationSnapshot() {
  if (typeof window === "undefined") {
    return "/";
  }

  return `${window.location.pathname}${window.location.search}`;
}

function subscribeToLocationChanges(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(WORKBENCH_URL_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(WORKBENCH_URL_CHANGE_EVENT, listener);
  };
}

function notifyLocationChanged() {
  window.dispatchEvent(new Event(WORKBENCH_URL_CHANGE_EVENT));
}

export function useWorkbenchRoute() {
  const locationSnapshot = useSyncExternalStore(
    subscribeToLocationChanges,
    readLocationSnapshot,
    () => "/",
  );
  const route = useMemo(
    () => parseWorkbenchRouteFromLocation(locationSnapshot),
    [locationSnapshot],
  );

  const navigateToRoute = useCallback((nextRoute: WorkbenchRoute, options: { replace?: boolean } = {}) => {
    const nextHref = createWorkbenchHref(nextRoute);
    const currentHref = readLocationSnapshot();
    if (nextHref !== currentHref) {
      if (options.replace) {
        window.history.replaceState(WORKBENCH_HISTORY_STATE, "", nextHref);
      } else {
        window.history.pushState(WORKBENCH_HISTORY_STATE, "", nextHref);
      }
      notifyLocationChanged();
    }
  }, []);

  return {
    navigateToRoute,
    route,
  };
}
