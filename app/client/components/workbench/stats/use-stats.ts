/*
 * Exports:
 * - WorkbenchStatsProvider: hand one stats store to the stats view's panels.
 * - default useStats: read the stats filters, scope and actions; `useStats.usage/overview/limits/claims/feedback/tools/status` lease and read one section; `useStats.failures` reads on-screen read failures.
 */
"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type WorkbenchStatsStore from "./WorkbenchStatsStore";
import type { StatsSectionName, StatsSectionSnapshot } from "./WorkbenchStatsStore";

const WorkbenchStatsContext = createContext<WorkbenchStatsStore | null>(null);
export const WorkbenchStatsProvider = WorkbenchStatsContext.Provider;

function useStore() {
  const store = useContext(WorkbenchStatsContext);
  if (!store) throw new Error("Stats panels render inside the stats view.");
  return store;
}

export default function useStats() {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** Mounting a panel demands its section; unmounting the last one releases the observation. */
function useSection<Name extends StatsSectionName>(name: Name): StatsSectionSnapshot<Name> {
  const store = useStore();
  const subscribe = useCallback((listener: () => void) => store.subscribeSection(name, listener), [store, name]);
  const read = useCallback(() => store.getSectionSnapshot(name), [store, name]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Usage narrowed to the picked period, with provider, model and token-type filters. */
useStats.usage = function useStatsUsage() { return useSection("usage"); };
/** Usage over the whole range, for the activity chart that picks periods. */
useStats.overview = function useStatsOverview() { return useSection("overview"); };
useStats.limits = function useStatsLimits() { return useSection("limits"); };
useStats.claims = function useStatsClaims() { return useSection("claims"); };
useStats.feedback = function useStatsFeedback() { return useSection("feedback"); };
useStats.tools = function useStatsTools() { return useSection("tools"); };
useStats.status = function useStatsStatus() { return useSection("status"); };
/** Read failures across the sections on screen. */
useStats.failures = function useStatsFailures() {
  const store = useStore();
  return useSyncExternalStore(store.subscribeFailures, store.getFailures, store.getFailures);
};
