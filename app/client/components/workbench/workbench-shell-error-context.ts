/*
 * Exports:
 * - WorkbenchShellErrorContext/useWorkbenchShellError: the shell's banner reporter; null outside the shell.
 */
"use client";

import { createContext, useContext } from "react";

export const WorkbenchShellErrorContext = createContext<((message: string) => void) | null>(null);

export function useWorkbenchShellError() {
  return useContext(WorkbenchShellErrorContext);
}
