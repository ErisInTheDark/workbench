/*
 * Exports:
 * - default WorkbenchWorkspaceContext/useWorkbenchWorkspace: share the tab's app workspace.
 * - WorkbenchOperationsContext/useWorkbenchDaemonClient: provide app-routed semantic domain operations for the selected view.
 * - WorkbenchDaemonAssetSource/WorkbenchDaemonAssetOriginContext/resolveWorkbenchDaemonAssetOrigin/useWorkbenchDaemonAssetOrigin: bind assets to app-owned routes.
 * - getWorkbenchTranscriptAssetUrl/getWorkbenchProjectIconUrl: resolve recognised resources without a daemon origin.
 */
"use client";

import { createContext, useContext } from "react";

import WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type WorkbenchWorkspaceClient from "../../workbench/app/WorkbenchWorkspaceClient";
import type { DaemonId } from "workbench-shared/workbench/identity";

const WorkbenchWorkspaceContext = createContext<WorkbenchWorkspaceClient | null>(null);
export const WorkbenchOperationsContext = createContext<WorkbenchDaemonClient | null>(null);
export type WorkbenchDaemonAssetSource =
  | { kind: "unavailable" }
  | { kind: "source"; daemonId: DaemonId };
export const WorkbenchDaemonAssetOriginContext = createContext<WorkbenchDaemonAssetSource>({ kind: "unavailable" });
const unavailableDaemonClient = new WorkbenchDaemonClient({
  request: async () => { throw new Error("The Workbench daemon client is not ready."); },
});

export function useWorkbenchDaemonClient() {
  return useContext(WorkbenchOperationsContext) ?? unavailableDaemonClient;
}

export function resolveWorkbenchDaemonAssetOrigin(source: WorkbenchDaemonAssetSource) {
  return source.kind === "source" ? `/api/workspace/assets/${encodeURIComponent(source.daemonId)}` : null;
}

export function useWorkbenchDaemonAssetOrigin() {
  return resolveWorkbenchDaemonAssetOrigin(useContext(WorkbenchDaemonAssetOriginContext));
}

export function useWorkbenchWorkspace() {
  const workspace = useContext(WorkbenchWorkspaceContext);
  if (!workspace) throw new Error("Workbench workspace context is unavailable.");
  return workspace;
}

export function getWorkbenchTranscriptAssetUrl(value: string, source: string | null) {
  return value.startsWith("/api/transcript-assets/")
    ? source ? `${source}/daemon/transcript-assets/${value.slice("/api/transcript-assets/".length)}` : null : value;
}

export function getWorkbenchProjectIconUrl(projectId: string, assetKey: string, source: string | null) {
  return source ? `${source}/daemon/project-icons/${encodeURIComponent(projectId)}?asset=${encodeURIComponent(assetKey)}` : null;
}

export default WorkbenchWorkspaceContext;
