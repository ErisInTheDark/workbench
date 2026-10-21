/*
 * Exports:
 * - default useWorkbenchSkillCatalogue: a provider's activatable skills for a project, and adoption of the daemon's list when it rejects a send.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import type { WorkbenchSkillSummary } from "workbench-shared/types";
import type { ProviderKey } from "workbench-shared/workbench/provider/provider-key";
import { readWorkbenchSkillActivationMismatch } from "workbench-shared/workbench/thread/thread-skill-mentions";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";

/** Like `useState`: the current catalogue, then a send-rejection handler that adopts the daemon's activatable skills. */
export default function useWorkbenchSkillCatalogue (projectId: string, provider: ProviderKey) {
  const daemon = useWorkbenchDaemonClient();
  const [skills, setSkills] = useState<WorkbenchSkillSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void daemon.skills.read({ projectId: projectId || null, provider }).then((payload) => {
      if (!cancelled) setSkills(payload.data ?? []);
    }).catch((error: unknown) => {
      if (cancelled) return;
      console.warn("Provider skill catalogue read failed.", (error instanceof Error ? error.message : String(error)).slice(0, 500));
      setSkills([]);
    });
    return () => {
      cancelled = true;
    };
  }, [daemon, projectId, provider]);

  const adoptRejectedSkills = useCallback((error: unknown) => {
    const mismatch = readWorkbenchSkillActivationMismatch(error);
    if (mismatch) setSkills(mismatch.activatableSkills);
  }, []);

  return [skills, adoptRejectedSkills] as const;
}
