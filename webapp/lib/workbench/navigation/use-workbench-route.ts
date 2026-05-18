/*
 * Exports:
 * - useWorkbenchRoute: React hook that reads browser route state and exposes guarded user navigation. Keywords: URL source of truth, popstate, pushState.
 */

import { useCallback, useEffect, useState } from "react";

import {
  createWorkbenchHref,
  isSameWorkbenchRoute,
  parseWorkbenchRouteFromLocation,
  type WorkbenchRoute,
} from "./workbench-route";

export function useWorkbenchRoute() {
  const [route, setRoute] = useState<WorkbenchRoute>(() => {
    if (typeof window === "undefined") {
      return parseWorkbenchRouteFromLocation("/");
    }

    return parseWorkbenchRouteFromLocation(window.location);
  });

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseWorkbenchRouteFromLocation(window.location));
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  const navigateToRoute = useCallback((nextRoute: WorkbenchRoute, options: { replace?: boolean } = {}) => {
    setRoute((currentRoute) => {
      if (isSameWorkbenchRoute(currentRoute, nextRoute)) {
        return currentRoute;
      }

      const nextHref = createWorkbenchHref(nextRoute);
      const currentHref = `${window.location.pathname}${window.location.search}`;
      if (nextHref !== currentHref) {
        if (options.replace) {
          window.history.replaceState(window.history.state, "", nextHref);
        } else {
          window.history.pushState(window.history.state, "", nextHref);
        }
      }

      return nextRoute;
    });
  }, []);

  return {
    navigateToRoute,
    route,
  };
}
