/*
 * Exports:
 * - default WorkbenchAppRpcContext/useWorkbenchAppRpc: expose the tab-owned app RPC without prop drilling.
 * - useWorkbenchAppConnectionInterrupted: whether the tab is (re)connecting to its app after having no live socket.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import type WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";

const WorkbenchAppRpcContext = createContext<WorkbenchAppRpcClient | null>(null);
export default WorkbenchAppRpcContext;
export const useWorkbenchAppRpc = () => useContext(WorkbenchAppRpcContext);

const NO_SUBSCRIPTION = () => () => undefined;

export function useWorkbenchAppConnectionInterrupted() {
  const rpc = useWorkbenchAppRpc();
  return useSyncExternalStore(
    rpc?.subscribe ?? NO_SUBSCRIPTION,
    () => {
      const phase = rpc?.getSnapshot().phase;
      return phase === "connecting" || phase === "reconnecting";
    },
    () => false,
  );
}
