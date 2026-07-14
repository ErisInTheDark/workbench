/*
 * Exports:
 * - default WorkbenchComposerProfileProvider: subscribe the React workbench tree to the composer profile controller. Keywords: composer, profile, provider, React.
 */
"use client";

import { useMemo, useSyncExternalStore, type ReactNode } from "react";

import WorkbenchComposerProfileController from "../../lib/workbench/state/WorkbenchComposerProfileController";
import WorkbenchComposerProfileContext from "./WorkbenchComposerProfileContext";

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
