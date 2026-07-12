/*
 * Exports:
 * - default WorkbenchComposerProfileProvider: subscribe the React workbench tree to the composer profile controller. Keywords: composer, profile, provider, React.
 * - useWorkbenchComposerProfiles: read the active profile controller and its current immutable snapshot. Keywords: composer, profile, hook, snapshot.
 */
"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import WorkbenchComposerProfileController, { type WorkbenchComposerProfileSnapshot } from "../../lib/workbench/state/WorkbenchComposerProfileController";

interface WorkbenchComposerProfileContextValue {
  controller: WorkbenchComposerProfileController;
  snapshot: WorkbenchComposerProfileSnapshot;
}

const WorkbenchComposerProfileContext = createContext<WorkbenchComposerProfileContextValue | null>(null);

export function useWorkbenchComposerProfiles() {
  const context = useContext(WorkbenchComposerProfileContext);
  if (!context) {
    throw new Error("Composer profile controls must be rendered inside WorkbenchComposerProfileProvider.");
  }

  return context;
}

export default function WorkbenchComposerProfileProvider({
  children,
  controller,
}: {
  children: ReactNode;
  controller: WorkbenchComposerProfileController;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const value = useMemo(() => ({ controller, snapshot }), [controller, snapshot]);
  return (
    <WorkbenchComposerProfileContext.Provider value={value}>
      {children}
    </WorkbenchComposerProfileContext.Provider>
  );
}
