/*
 * Exports:
 * - useWorkbenchRoute: React hook that derives workbench route state from Next App Router and exposes guarded user navigation. Keywords: URL source of truth, Next router, pathname, search params.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import {
  createWorkbenchHref,
  parseWorkbenchRouteFromLocation,
  type WorkbenchRoute,
} from "./workbench-route";

export function useWorkbenchRoute() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const locationSnapshot = useMemo(
    () => `${pathname || "/"}${search ? `?${search}` : ""}`,
    [pathname, search],
  );
  const route = useMemo(
    () => parseWorkbenchRouteFromLocation(locationSnapshot),
    [locationSnapshot],
  );

  const navigateToRoute = useCallback((nextRoute: WorkbenchRoute, options: { replace?: boolean } = {}) => {
    const nextHref = createWorkbenchHref(nextRoute);
    if (nextHref === locationSnapshot) {
      return;
    }

    if (options.replace) {
      router.replace(nextHref, { scroll: false });
    } else {
      router.push(nextHref, { scroll: false });
    }
  }, [locationSnapshot, router]);

  return {
    navigateToRoute,
    route,
  };
}
