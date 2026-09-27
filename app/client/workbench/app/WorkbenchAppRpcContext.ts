/*
 * Exports:
 * - default WorkbenchAppRpcContext/useWorkbenchAppRpc: expose the tab-owned app RPC without prop drilling.
 */
import { createContext, useContext } from "react";
import type WorkbenchAppRpcClient from "./WorkbenchAppRpcClient";

const WorkbenchAppRpcContext = createContext<WorkbenchAppRpcClient | null>(null);
export default WorkbenchAppRpcContext;
export const useWorkbenchAppRpc = () => useContext(WorkbenchAppRpcContext);
