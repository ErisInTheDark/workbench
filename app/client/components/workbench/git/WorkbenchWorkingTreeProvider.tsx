/*
 * Exports:
 * - default WorkbenchWorkingTreeProvider: bind one working-tree owner to the selected project.
 * - useWorkingTree/useWorkingTreeSnapshot: consume domain state without prop transport.
 */
"use client";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import WorkbenchWorkingTreeState from "../../../workbench/git/WorkbenchWorkingTreeState";
import WorkbenchDaemonClientContext from "../WorkbenchDaemonClientContext";

const Context = createContext<WorkbenchWorkingTreeState | null>(null);
export function useWorkingTree() {
  const state = useContext(Context);
  if (!state) throw new Error("Working-tree provider is required.");
  return state;
}
export function useWorkingTreeSnapshot() {
  const state = useWorkingTree();
  return useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
}
export default function WorkbenchWorkingTreeProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const daemon = useContext(WorkbenchDaemonClientContext);
  const state = useMemo(() => new WorkbenchWorkingTreeState(projectId, daemon?.git.workingTree ?? null), [daemon, projectId]);
  useEffect(() => {
    if (!daemon) return;
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
  }, [daemon, state]);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}
