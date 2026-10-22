/*
 * Exports:
 * - DeviceReloadOperationSchema/DeviceReloadOperation/IDLE_DEVICE_RELOAD_OPERATION: the app's in-flight reload-all or pull
 *   sequence and the daemon it targets.
 * - toBaseReloadOperation: the same operation in the process-owned shape, for consumers that predate device targets.
 */
import { z } from "zod";
import { IDLE_RELOAD_OPERATION, WorkbenchReloadOperationSchema, type WorkbenchReloadOperation } from "./workbench-reload.ts";

export const DeviceReloadOperationSchema = WorkbenchReloadOperationSchema.extend({
  /** The daemon the operation targets; null for this device's attached daemon. */
  daemonId: z.string().max(128).nullable().default(null),
});
export type DeviceReloadOperation = z.infer<typeof DeviceReloadOperationSchema>;
export const IDLE_DEVICE_RELOAD_OPERATION: DeviceReloadOperation = { ...IDLE_RELOAD_OPERATION, daemonId: null };

export function toBaseReloadOperation({ daemonId: _daemonId, ...operation }: DeviceReloadOperation): WorkbenchReloadOperation {
  return operation;
}
