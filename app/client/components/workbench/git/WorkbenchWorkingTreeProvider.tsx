/*
 * Exports:
 * - default WorkbenchWorkingTreeProvider: bind one working-tree owner to the selected project.
 * - useWorkingTree/useWorkingTreeSnapshot: consume domain state without prop transport.
 * - useWorkingTreeDaemonId: identify the concrete daemon owning Git thread links.
 */
"use client";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import WorkbenchWorkingTreeState, { type WorkingTreeSummarySource } from "../../../workbench/git/WorkbenchWorkingTreeState";
import WorkbenchWorkspaceContext, { WorkbenchOperationsContext as WorkbenchDaemonClientContext } from "../WorkbenchWorkspaceContext";
import { DaemonIdSchema, ProjectIdSchema } from "workbench-shared/workbench/identity";
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";

const Context = createContext<WorkbenchWorkingTreeState | null>(null);
const DaemonIdContext = createContext<string | null>(null);
export function useWorkingTree() {
  const state = useContext(Context);
  if (!state) throw new Error("Working-tree provider is required.");
  return state;
}
export function useWorkingTreeSnapshot() {
  const state = useWorkingTree();
  return useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
}
export function useWorkingTreeDaemonId() {
  return useContext(DaemonIdContext);
}
export default function WorkbenchWorkingTreeProvider({ projectId, children, sourceDaemon, sourceDaemonId }: {
  projectId: string; children: ReactNode; sourceDaemon?: WorkbenchDaemonClient | null;
  sourceDaemonId?: string | null;
}) {
  const inheritedDaemon = useContext(WorkbenchDaemonClientContext);
  const inheritedState = useContext(Context);
  const inheritedDaemonId = useContext(DaemonIdContext);
  const daemon = sourceDaemon === undefined ? inheritedDaemon : sourceDaemon;
  const reuse = Boolean(inheritedState && inheritedState.projectId === projectId
    && inheritedDaemonId === (sourceDaemonId ?? null)
    && daemon === inheritedDaemon);
  const workspace = useContext(WorkbenchWorkspaceContext);
  const daemonId = sourceDaemonId ?? null;
  const state = useMemo(() => {
    if (reuse && inheritedState) return inheritedState;
    const location = daemonId && projectId
      ? { daemonId: DaemonIdSchema.parse(daemonId), projectId: ProjectIdSchema.parse(projectId) } : null;
    const summary: WorkingTreeSummarySource | null = workspace && location ? changed => {
      const handle = workspace.observe({ kind: "workingTreeSummary", location }, changed);
      return {
        getSnapshot: () => {
          const fact = handle.getSnapshot();
          return { phase: fact.phase, failure: fact.failure, summary: fact.value?.data ?? null };
        },
        release: () => handle.release(),
      };
    } : null;
    return new WorkbenchWorkingTreeState(projectId, daemon?.git.workingTree ?? null, summary);
  }, [daemon, daemonId, inheritedState, projectId, reuse, workspace]);
  useEffect(() => {
    if (!daemon || reuse) return;
    state.activate();
    const visibility = () => state.setVisible(!document.hidden);
    const focus = () => { if (!document.hidden) state.refreshDemanded(); };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    const unsubscribe = daemon.onReconnect(focus);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      unsubscribe();
      state.dispose();
    };
  }, [daemon, reuse, state]);
  // One render shape for every scope: swapping structure here would remount every child.
  return <DaemonIdContext.Provider value={sourceDaemonId ?? null}>
    <Context.Provider value={state}>{children}</Context.Provider>
  </DaemonIdContext.Provider>;
}
