/*
 * Exports:
 * - WorkbenchStatsProvider: hand the app-wide stats store to everything that reads stats.
 * - default useStats: read the stats filters, scope and actions; `useStats.usage/overview/limits/claims/feedback/tools/status` lease and read one section;
 *   `useStats.failures` reads on-screen read failures; `useStats.store` reaches the store for the stats view's inputs;
 *   `useStats.feedbackReport` leases one feedback report; `useStats.modelNames` names feedback authors' models.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { WorkbenchHarness, WorkbenchModelOption } from "workbench-shared/types";
import { matchesWorkbenchModelOption } from "workbench-shared/workbench/provider/provider-model";
import WorkbenchClientContext from "../workbench-client-context";
import type WorkbenchStatsStore from "./WorkbenchStatsStore";
import type { StatsFeedbackReport, StatsFeedbackReportSnapshot, StatsSectionName, StatsSectionSnapshot } from "./WorkbenchStatsStore";

const WorkbenchStatsContext = createContext<WorkbenchStatsStore | null>(null);
export const WorkbenchStatsProvider = WorkbenchStatsContext.Provider;

function useStore() {
  const store = useContext(WorkbenchStatsContext);
  if (!store) throw new Error("Stats readers render inside the app's stats provider.");
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
useStats.store = useStore;

/** Null reads nothing, so callers can wait to demand a report until it is shown. */
useStats.feedbackReport = function useStatsFeedbackReport(report: StatsFeedbackReport | null): StatsFeedbackReportSnapshot | null {
  const store = useStore();
  const feedbackId = report?.feedbackId;
  const threadId = report?.threadId;
  const subscribe = useCallback((listener: () => void) => feedbackId === undefined || threadId === undefined
    ? () => {}
    : store.subscribeFeedbackReport({ feedbackId, threadId }, listener), [store, feedbackId, threadId]);
  const read = useCallback(() => feedbackId === undefined || threadId === undefined
    ? null
    : store.getFeedbackReportSnapshot({ feedbackId, threadId }), [store, feedbackId, threadId]);
  return useSyncExternalStore(subscribe, read, read);
};

/**
 * Display names for the models that authored feedback, from each harness's shared model catalogue.
 * Chrome-free thread surfaces have no Workbench client, so they show the stored model id.
 */
useStats.modelNames = function useStatsModelNames(harnesses: readonly WorkbenchHarness[]) {
  const controls = useContext(WorkbenchClientContext)?.controls ?? null;
  const [catalogues, setCatalogues] = useState<ReadonlyMap<string, readonly WorkbenchModelOption[]>>(new Map());
  const key = [...new Set(harnesses)].sort().join("\0");
  useEffect(() => {
    if (!controls) return;
    let active = true;
    for (const harness of key ? key.split("\0") as WorkbenchHarness[] : []) {
      controls.listModels(harness).then((models) => {
        if (active) setCatalogues((current) => new Map(current).set(harness, models));
      }).catch((error: unknown) => {
        console.warn("Feedback model names are unavailable.", {
          harness, reason: (error instanceof Error ? error.message : "Model read failed").slice(0, 300),
        });
      });
    }
    return () => { active = false; };
  }, [controls, key]);
  return useCallback((harness: string | null, model: string | null) => {
    if (!model) return null;
    const known = harness ? catalogues.get(harness)?.find((option) => matchesWorkbenchModelOption(option, model)) : undefined;
    return known?.displayName ?? model.slice(model.indexOf("/") + 1);
  }, [catalogues]);
};
