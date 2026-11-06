/*
 * Exports:
 * - readAppRpcFailure: the JSON-RPC code and data a browser receives for a failed app request.
 */
import { WorkbenchDaemonRequestError } from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import { WorkbenchRpcRequestInterruptedError } from "workbench-shared/workbench/WorkbenchRpcSocketClient";
import { WORKSPACE_COMMAND_NOT_SENT, WORKSPACE_COMMAND_UNCERTAIN } from "workbench-shared/workbench/workspace/workspace-commands";
import { z } from "zod";

export function readAppRpcFailure(error: unknown) {
  if (WorkbenchRpcRequestInterruptedError.is(error)) {
    return { code: error.dispatched ? WORKSPACE_COMMAND_UNCERTAIN : WORKSPACE_COMMAND_NOT_SENT };
  }
  if (!WorkbenchDaemonRequestError.is(error)) return { code: -32000 };
  const data = z.json().safeParse(error.data);
  return { code: error.code, ...(data.success ? { data: data.data } : {}) };
}
