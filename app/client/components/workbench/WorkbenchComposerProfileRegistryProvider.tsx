/*
 * Exports:
 * - default WorkbenchComposerProfileRegistryProvider: own one composer profile controller per daemon scope for the tab's
 *   lifetime and dispose them all on unmount.
 */
"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import WorkbenchComposerProfileController from "../../workbench/state/WorkbenchComposerProfileController";
import { WorkbenchComposerProfileRegistryContext } from "./WorkbenchComposerProfileContext";

export default function WorkbenchComposerProfileRegistryProvider({ children }: { children: ReactNode }) {
  const [controllers] = useState(() => new Map<string, WorkbenchComposerProfileController>());
  const controllerFor = useCallback((scopeKey: string) => {
    const existing = controllers.get(scopeKey);
    if (existing) return existing;
    const controller = new WorkbenchComposerProfileController();
    controllers.set(scopeKey, controller);
    return controller;
  }, [controllers]);
  useEffect(() => () => {
    for (const controller of controllers.values()) controller.dispose();
    controllers.clear();
  }, [controllers]);
  return (
    <WorkbenchComposerProfileRegistryContext.Provider value={controllerFor}>
      {children}
    </WorkbenchComposerProfileRegistryContext.Provider>
  );
}
