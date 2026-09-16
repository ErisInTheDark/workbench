/*
 * Exports:
 * - WorkbenchRpcResponse/WorkbenchRpcFailure: transport response envelope before method-specific validation.
 * - isWorkbenchRpcFailure: distinguish a rejected response.
 * - createWorkbenchRequestIdGenerator: connection-local monotonically increasing request IDs.
 */
import type { JsonValue } from "./thread/workbench-thread-items.ts";

export interface WorkbenchRpcFailure {
  id: number | null;
  error: { code: number; message: string; data?: JsonValue };
}
export type WorkbenchRpcResponse<TResult> = { id: number; result: TResult } | WorkbenchRpcFailure;
export function isWorkbenchRpcFailure<TResult>(response: WorkbenchRpcResponse<TResult>): response is WorkbenchRpcFailure {
  return "error" in response;
}
export function createWorkbenchRequestIdGenerator(startAt = 1) {
  let next = startAt;
  return () => next++;
}
