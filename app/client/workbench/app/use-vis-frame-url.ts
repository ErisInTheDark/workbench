/*
 * Exports:
 * - default useVisFrameUrl: where this tab loads one vis document: the app's vis origin as this browser reaches it, the
 *   daemon that owns the thread, and the session's variant; null until all are known.
 */
"use client";

import { useContext, useEffect, useMemo, useState } from "react";
import { ThreadReferenceSchema } from "workbench-shared/workbench/identity";
import { VIS_REVISION_PARAM, visFramePath, type VisVariant } from "workbench-shared/workbench/vis/vis-url";
import WorkbenchWorkspaceContext from "../../components/workbench/WorkbenchWorkspaceContext";
import { readWorkbenchAppPort } from "./workbench-app-port-client";
import { useWorkbenchAppConnectionInterrupted, useWorkbenchAppRpc } from "./WorkbenchAppRpcContext";
import useWorkspaceObservation from "./use-workspace-observation";

/** Re-read after every reconnect: a restarted app listens for vis pages on a new local port. */
function useVisOrigin() {
  const rpc = useWorkbenchAppRpc();
  const interrupted = useWorkbenchAppConnectionInterrupted();
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    if (!rpc || interrupted) return;
    let current = true;
    readWorkbenchAppPort(rpc).then(
      snapshot => { if (current) setOrigin(snapshot.visOrigin ?? null); },
      (error: unknown) => {
        if (current) setOrigin(null);
        console.error("The vis origin could not be read.", error);
      },
    );
    return () => { current = false; };
  }, [rpc, interrupted]);
  return origin;
}

/** `revision` changes with each render, so the frame reloads onto it; snapshots never change and pass 0. */
export default function useVisFrameUrl(threadId: string, sessionId: string, variant: VisVariant, revision: number) {
  const origin = useVisOrigin();
  const workspace = useContext(WorkbenchWorkspaceContext);
  const owner = useWorkspaceObservation(workspace, { kind: "threadOwner", threadId: ThreadReferenceSchema.parse(threadId) }).value?.data;
  const daemonId = owner?.phase === "current" ? owner.location.daemonId : null;
  return useMemo(() => {
    if (!origin || !daemonId) return null;
    const url = new URL(visFramePath(daemonId, sessionId, variant), origin);
    url.searchParams.set(VIS_REVISION_PARAM, String(revision));
    return url.href;
  }, [daemonId, origin, revision, sessionId, variant]);
}
