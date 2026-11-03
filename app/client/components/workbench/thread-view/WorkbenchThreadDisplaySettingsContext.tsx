/*
 * Exports:
 * - WorkbenchThreadDisplaySettingsContext: owning pane's resolved code-detail preference.
 * - useThreadCodeDetails: whether code-mode executions show as their own steps: the pane's preference, else the global setting.
 * - useThreadShownRejections: the rejected tool call kinds the user chose to see; every other kind stays hidden.
 */
"use client";

import { createContext, useContext, useMemo } from "react";

import type { RejectedToolCallKind } from "../../../workbench/thread/thread-rejected-tool-calls";
import { useSettings } from "../use-settings";

export const WorkbenchThreadDisplaySettingsContext = createContext<boolean | null>(null);

export function useThreadCodeDetails(): boolean {
  const global = useSettings().get("threadCodeDetails");
  return useContext(WorkbenchThreadDisplaySettingsContext) ?? global;
}

export function useThreadShownRejections(): ReadonlySet<RejectedToolCallKind> {
  const settings = useSettings();
  const modeDenials = settings.get("threadModeDenials");
  const unknownTools = settings.get("threadUnknownToolCalls");
  return useMemo(() => new Set<RejectedToolCallKind>([
    ...modeDenials ? ["modeDenial" as const] : [],
    ...unknownTools ? ["unknownTool" as const] : [],
  ]), [modeDenials, unknownTools]);
}
