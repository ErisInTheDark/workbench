/*
 * Exports:
 * - SubagentActivityProps: the child a wait preview shows.
 * - SubagentActivitySlot: the child-activity preview, provided by the turn renderer. The preview renders blocks whose
 *   command renderers show previews, so they reach it through this slot rather than importing it in a cycle.
 */
import { createContext, type ComponentType } from "react";

import type { WorkbenchSubagentSummary } from "workbench-shared/types";
import type { RelatedThread } from "../../../../workbench/thread/ThreadStore";

export interface SubagentActivityProps {
  fallbackThread: RelatedThread | undefined;
  subagent: WorkbenchSubagentSummary | null | undefined;
}

export const SubagentActivitySlot = createContext<ComponentType<SubagentActivityProps>>(() => null);
