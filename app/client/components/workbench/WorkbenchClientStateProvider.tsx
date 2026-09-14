/*
 * Exports:
 * - default WorkbenchClientStateProvider: provide one explicit app controller to the browser tree. Keywords: browser, state, React, provider.
 */
"use client";

import type { ReactNode } from "react";

import WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import { WorkbenchClientStateContext } from "./workbench-client-state-context";

export default function WorkbenchClientStateProvider({
  children,
  controller,
}: {
  children: ReactNode;
  controller: WorkbenchClientStateController;
}) {
  return (
    <WorkbenchClientStateContext.Provider value={controller}>
      {children}
    </WorkbenchClientStateContext.Provider>
  );
}
