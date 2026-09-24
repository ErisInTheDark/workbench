/*
 * Exports:
 * - useWorkbenchDaemonClient: read the mounted semantic daemon client. Keywords: daemon, context, browser.
 * - default WorkbenchDaemonClientContext: provide one socket-backed daemon client to nested Workbench UI.
 * - WorkbenchDaemonAssetOriginContext/useWorkbenchDaemonAssetOrigin: keep HTTP assets on that same daemon.
 */
"use client";

import { createContext, useContext } from "react";

import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";

const WorkbenchDaemonClientContext = createContext<WorkbenchDaemonClient | null>(null);
export const WorkbenchDaemonAssetOriginContext = createContext<{ origin: string | null } | null>(null);
const unavailableDaemonClient = new WorkbenchDaemonClient({
  request: async () => { throw new Error("The Workbench daemon client is not ready."); },
});

export function useWorkbenchDaemonClient() {
  return useContext(WorkbenchDaemonClientContext) ?? unavailableDaemonClient;
}

export function useWorkbenchDaemonAssetOrigin() {
  return useContext(WorkbenchDaemonAssetOriginContext)?.origin;
}

export default WorkbenchDaemonClientContext;
