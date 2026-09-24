/*
 * Exports:
 * - default WorkbenchWorkingTreeProvider: bind one working-tree owner to the selected project.
 * - useWorkingTree/useWorkingTreeSnapshot: consume domain state without prop transport.
 * - useWorkingTreeDaemonId: identify the concrete daemon owning Git thread links.
 */
"use client";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import WorkbenchWorkingTreeState from "../../../workbench/git/WorkbenchWorkingTreeState";
import WorkbenchDaemonClientContext from "../WorkbenchDaemonClientContext";
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
  const state = useMemo(() => reuse && inheritedState
    ? inheritedState : new WorkbenchWorkingTreeState(projectId, daemon?.git.workingTree ?? null),
  [daemon, inheritedState, projectId, reuse]);
  useEffect(() => {
    if (!daemon || reuse) return;
    state.activate();
    const visibility = () => state.setVisible(!document.hidden);
    const focus = () => { if (!document.hidden) void state.refresh(); };
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
  if (reuse) return <>{children}</>;
  return <DaemonIdContext.Provider value={sourceDaemonId ?? null}>
    <Context.Provider value={state}>{children}</Context.Provider>
  </DaemonIdContext.Provider>;
}
