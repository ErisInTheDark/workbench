/*
 * Exports:
 * - WorkbenchClientController: the mounted Workbench client and its controls, stable for the whole mount.
 * - default WorkbenchClientContext: provide one mounted Workbench client to domain hooks.
 * - useWorkbenchClientController: resolve the explicit or provided domain owner.
 */
"use client";

import { createContext, useContext } from "react";

import type { WorkbenchControls } from "workbench-shared/types";
import type { MountedWorkbenchClient } from "../../WorkbenchClient";

export interface WorkbenchClientController {
  controls: WorkbenchControls | null;
  mounted: MountedWorkbenchClient | null;
}

const WorkbenchClientContext = createContext<WorkbenchClientController | null>(null);

export function useWorkbenchClientController(explicitClient?: WorkbenchClientController) {
  const providedClient = useContext(WorkbenchClientContext);
  const client = explicitClient ?? providedClient;
  if (!client) throw new Error("Workbench domain hooks require WorkbenchClientProvider.");
  return client;
}

export default WorkbenchClientContext;
