/*
 * Exports:
 * - useWorkbenchDaemonClient: read the mounted semantic daemon client. Keywords: daemon, context, browser.
 * - default WorkbenchDaemonClientContext: provide one socket-backed daemon client to nested Workbench UI.
 * - WorkbenchDaemonAssetSource/WorkbenchDaemonAssetOriginContext/resolveWorkbenchDaemonAssetOrigin/useWorkbenchDaemonAssetOrigin: bind HTTP assets to their source daemon.
 */
"use client";

import { createContext, useContext } from "react";

import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { getWorkbenchDaemonHttpOrigin } from "workbench-shared/workbench/workbench-connection";

const WorkbenchDaemonClientContext = createContext<WorkbenchDaemonClient | null>(null);
export type WorkbenchDaemonAssetSource =
  | { kind: "attached" }
  | { kind: "peer"; origin: string | null };
export const WorkbenchDaemonAssetOriginContext = createContext<WorkbenchDaemonAssetSource>({ kind: "attached" });
const unavailableDaemonClient = new WorkbenchDaemonClient({
  request: async () => { throw new Error("The Workbench daemon client is not ready."); },
});

export function useWorkbenchDaemonClient() {
  return useContext(WorkbenchDaemonClientContext) ?? unavailableDaemonClient;
}

export function resolveWorkbenchDaemonAssetOrigin(source: WorkbenchDaemonAssetSource) {
  return source.kind === "attached" ? getWorkbenchDaemonHttpOrigin() : source.origin;
}

export function useWorkbenchDaemonAssetOrigin() {
  return resolveWorkbenchDaemonAssetOrigin(useContext(WorkbenchDaemonAssetOriginContext));
}

export default WorkbenchDaemonClientContext;
