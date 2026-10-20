/*
 * Exports:
 * - WorkbenchThreadDisplaySettingsContext: owning pane's resolved code-detail preference.
 * - useThreadCodeDetails: whether code-mode executions show as their own steps: the pane's preference, else the global setting.
 */
"use client";

import { createContext, useContext } from "react";

import { useSettings } from "../use-settings";

export const WorkbenchThreadDisplaySettingsContext = createContext<boolean | null>(null);

export function useThreadCodeDetails(): boolean {
  const global = useSettings().get("threadCodeDetails");
  return useContext(WorkbenchThreadDisplaySettingsContext) ?? global;
}
