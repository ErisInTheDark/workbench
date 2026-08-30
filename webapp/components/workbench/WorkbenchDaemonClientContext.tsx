/*
 * Exports:
 * - useWorkbenchDaemonClient: read the mounted semantic daemon client. Keywords: daemon, context, browser.
 * - default WorkbenchDaemonClientContext: provide one socket-backed daemon client to nested Workbench UI. Keywords: daemon, react, provider.
 */
"use client";

import { createContext, useContext } from "react";

import WorkbenchDaemonClient from "../../lib/workbench/daemon/WorkbenchDaemonClient";

const WorkbenchDaemonClientContext = createContext<WorkbenchDaemonClient | null>(null);
const unavailableDaemonClient = new WorkbenchDaemonClient({
  request: async () => { throw new Error("The Workbench daemon client is not ready."); },
});

export function useWorkbenchDaemonClient() {
  return useContext(WorkbenchDaemonClientContext) ?? unavailableDaemonClient;
}

export default WorkbenchDaemonClientContext;
