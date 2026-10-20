/*
 * Exports:
 * - WorkbenchComposerProfileContextValue: active composer profile controller and immutable snapshot.
 * - WorkbenchComposerProfileRegistryContext: per-daemon-scope controller lookup, provided by WorkbenchComposerProfileRegistryProvider.
 * - useWorkbenchComposerProfiles: read the active composer profile context; `.registry` returns the per-scope controller lookup.
 * - default WorkbenchComposerProfileContext: canonical React context shared by the provider and consumers.
 */
"use client";

import { createContext, useContext } from "react";

import WorkbenchComposerProfileController, { type WorkbenchComposerProfileSnapshot } from "../../workbench/state/WorkbenchComposerProfileController";

export interface WorkbenchComposerProfileContextValue {
  controller: WorkbenchComposerProfileController;
  snapshot: WorkbenchComposerProfileSnapshot;
}

const WorkbenchComposerProfileContext = createContext<WorkbenchComposerProfileContextValue | null>(null);

export const WorkbenchComposerProfileRegistryContext = createContext<
  ((scopeKey: string) => WorkbenchComposerProfileController) | null
>(null);

export function useWorkbenchComposerProfiles() {
  const context = useContext(WorkbenchComposerProfileContext);
  if (!context) {
    throw new Error("Composer profile controls must be rendered inside WorkbenchComposerProfileProvider.");
  }

  return context;
}

/** Null outside WorkbenchComposerProfileRegistryProvider, such as chrome-free test surfaces. */
useWorkbenchComposerProfiles.registry = function useWorkbenchComposerProfileRegistry() {
  return useContext(WorkbenchComposerProfileRegistryContext);
};

export default WorkbenchComposerProfileContext;
