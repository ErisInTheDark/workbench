/*
 * Exports:
 * - ThreadWorkflowModeCatalogueContext: the open thread project's declared workflow modes.
 * - default useWorkflowModeCatalogue: read a project's declared modes from its daemon; empty until loaded or when the read fails.
 */
"use client";

import { createContext, useEffect, useState } from "react";

import type { WorkflowMode } from "workbench-shared/workbench/thread/workflow-modes";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";

export const ThreadWorkflowModeCatalogueContext = createContext<readonly WorkflowMode[]>([]);

export default function useWorkflowModeCatalogue(projectId: string) {
  const daemon = useWorkbenchDaemonClient();
  const [modes, setModes] = useState<readonly WorkflowMode[]>([]);

  useEffect(() => {
    let cancelled = false;
    void daemon.workflowModes.read({ projectId: projectId || null }).then((payload) => {
      if (!cancelled) setModes(payload.data);
    }).catch((error: unknown) => {
      if (cancelled) return;
      console.warn("Workflow mode read failed.", (error instanceof Error ? error.message : String(error)).slice(0, 500));
      setModes([]);
    });
    return () => {
      cancelled = true;
    };
  }, [daemon, projectId]);

  return modes;
}
