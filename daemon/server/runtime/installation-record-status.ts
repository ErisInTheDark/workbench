/*
 * Exports:
 * - readInstallationRecordStatus: classify the data root's installation record against the running checkout.
 * - adoptInstallationRecord: record the running checkout as the ready installation under the installer lock.
 */
import path from "node:path";
import type { InstallationRecordStatus } from "workbench-shared/workbench/installation-record";
import WorkbenchInstallationRecord from "../../../package/WorkbenchInstallationRecord.mjs";

interface Options {
  checkoutRoot: string;
  dataRoot: string;
}

function sameDirectory(left: string, right: string) {
  const [a, b] = [path.resolve(left), path.resolve(right)];
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export async function readInstallationRecordStatus({ checkoutRoot, dataRoot }: Options): Promise<InstallationRecordStatus> {
  let recorded;
  try {
    recorded = await new WorkbenchInstallationRecord({ dataRoot }).read();
  } catch (error) {
    return { checkoutRoot, record: { state: "invalid", message: (error instanceof Error ? error.message : String(error)).slice(0, 512) } };
  }
  if (!recorded) return { checkoutRoot, record: { state: "missing" } };
  if (recorded.phase === "ready" && sameDirectory(recorded.root, checkoutRoot)) return { checkoutRoot, record: { state: "current" } };
  return { checkoutRoot, record: { state: "elsewhere", root: recorded.root, phase: recorded.phase } };
}

export async function adoptInstallationRecord(options: Options): Promise<InstallationRecordStatus> {
  const record = new WorkbenchInstallationRecord({ dataRoot: options.dataRoot });
  const lock = await record.lock();
  try {
    await record.write({ version: 1, root: path.resolve(options.checkoutRoot), phase: "ready" });
  } finally {
    lock.close();
  }
  return await readInstallationRecordStatus(options);
}
