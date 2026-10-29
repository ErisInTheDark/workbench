/*
 * Exports:
 * - ThreadProofOfWorkCatalogueContext: the open thread project's declared proof-of-work checklists.
 * - default useProofOfWorkCatalogue: read a project's declared checklists from its daemon; empty until loaded or when the read fails.
 */
"use client";

import { createContext, useEffect, useState } from "react";

import type { ProofOfWorkChecklist } from "workbench-shared/workbench/thread/proof-of-work";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";

export const ThreadProofOfWorkCatalogueContext = createContext<readonly ProofOfWorkChecklist[]>([]);

export default function useProofOfWorkCatalogue(projectId: string) {
  const daemon = useWorkbenchDaemonClient();
  const [checklists, setChecklists] = useState<readonly ProofOfWorkChecklist[]>([]);

  useEffect(() => {
    let cancelled = false;
    void daemon.proofOfWork.read({ projectId: projectId || null }).then((payload) => {
      if (!cancelled) setChecklists(payload.data);
    }).catch((error: unknown) => {
      if (cancelled) return;
      console.warn("Proof-of-work checklist read failed.", (error instanceof Error ? error.message : String(error)).slice(0, 500));
      setChecklists([]);
    });
    return () => {
      cancelled = true;
    };
  }, [daemon, projectId]);

  return checklists;
}
