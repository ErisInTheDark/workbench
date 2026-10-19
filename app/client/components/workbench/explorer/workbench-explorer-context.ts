/*
 * Exports:
 * - WorkbenchExplorerContext: the mounted client's explorer snapshot, provided once by the workbench shell.
 * - useWorkbenchExplorer: read the selected folder's tree, projects, drafts and expansion state.
 */
"use client";

import { createContext, useContext } from "react";

import type { ExplorerSnapshot } from "workbench-shared/types";

export const WorkbenchExplorerContext = createContext<ExplorerSnapshot | null>(null);

export function useWorkbenchExplorer() {
  const explorer = useContext(WorkbenchExplorerContext);
  if (!explorer) throw new Error("useWorkbenchExplorer must be used inside the workbench shell.");
  return explorer;
}
