/*
 * Exports:
 * - default WorkbenchThreadDaemonScope: route daemon calls and assets under it to a thread's own daemon, keeping the outer one when the thread's context is unknown.
 */
"use client";

import { useContext, type ReactNode } from "react";

import type { MountedWorkbenchClient } from "../../WorkbenchClient";
import { WorkbenchOperationsContext as WorkbenchDaemonClientContext, WorkbenchDaemonAssetOriginContext, useWorkbenchDaemonClient } from "./WorkbenchWorkspaceContext";

type ThreadDaemonContext = Pick<NonNullable<ReturnType<MountedWorkbenchClient["threadContextFor"]>>, "assetSource" | "daemon">;

export default function WorkbenchThreadDaemonScope({ children, context }: {
  children: ReactNode;
  /** From `threadContextFor` or `launchContextFor`; absent keeps the outer daemon. */
  context: ThreadDaemonContext | null | undefined;
}) {
  const outerDaemon = useWorkbenchDaemonClient();
  const outerAssetSource = useContext(WorkbenchDaemonAssetOriginContext);
  return (
    <WorkbenchDaemonClientContext.Provider value={context?.daemon ?? outerDaemon}>
      <WorkbenchDaemonAssetOriginContext.Provider value={context?.assetSource ?? outerAssetSource}>
        {children}
      </WorkbenchDaemonAssetOriginContext.Provider>
    </WorkbenchDaemonClientContext.Provider>
  );
}
