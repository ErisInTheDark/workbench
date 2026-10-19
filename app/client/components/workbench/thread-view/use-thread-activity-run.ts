/*
 * Exports:
 * - default useThreadActivityRun: one activity run's expanded state and toggle, kept by the viewport so windowing remounts keep it.
 */
"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

import ThreadActivityRunController from "./ThreadActivityRunController";
import { useThreadScrollViewportContext } from "./thread-scroll-viewport-context";

export default function useThreadActivityRun(identity: string) {
  const [ownRuns] = useState(() => new ThreadActivityRunController());
  const runs = useThreadScrollViewportContext().activityRuns ?? ownRuns;
  const subscribe = useCallback((listener: () => void) => runs.subscribe(listener), [runs]);
  const open = useSyncExternalStore(subscribe, () => runs.isOpen(identity), () => runs.isOpen(identity));
  const toggle = useCallback(() => runs.setOpen(identity, !runs.isOpen(identity)), [identity, runs]);
  return { open, toggle };
}
