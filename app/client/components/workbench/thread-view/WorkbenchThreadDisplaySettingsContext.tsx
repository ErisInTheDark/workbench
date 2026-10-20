/*
 * Exports:
 * - WorkbenchThreadDisplaySettingsContext: owning pane's resolved code-detail preference.
 * - useThreadCodeDetails: whether code-mode executions show as their own steps: the pane's preference, else the global setting.
 */
"use client";

import { createContext, useContext } from "react";

import { readGlobalWorkbenchSettings } from "../../../workbench/state/workbench-settings";
import { useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";

export const WorkbenchThreadDisplaySettingsContext = createContext<boolean | null>(null);

export function useThreadCodeDetails(): boolean {
  const state = useWorkbenchClientStateSnapshot();
  return useContext(WorkbenchThreadDisplaySettingsContext) ?? readGlobalWorkbenchSettings(state.records).threadCodeDetails;
}
