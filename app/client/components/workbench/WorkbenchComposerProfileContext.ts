/*
 * Exports:
 * - WorkbenchComposerProfileContextValue: active composer profile controller and immutable snapshot. Keywords: composer, profile, context, snapshot.
 * - useWorkbenchComposerProfiles: read the canonical composer profile context. Keywords: composer, profile, hook, snapshot.
 * - default WorkbenchComposerProfileContext: canonical React context shared by the provider and consumers. Keywords: composer, profile, context, provider.
 */
"use client";

import { createContext, useContext } from "react";

import WorkbenchComposerProfileController, { type WorkbenchComposerProfileSnapshot } from "../../workbench/state/WorkbenchComposerProfileController";

export interface WorkbenchComposerProfileContextValue {
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

export default WorkbenchComposerProfileContext;
