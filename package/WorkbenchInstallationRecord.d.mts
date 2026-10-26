/*
 * Exports:
 * - WorkbenchInstallationPhase/WorkbenchInstallationRecordValue: one recorded installation.
 * - default WorkbenchInstallationRecord: read, write and exclusively lock the data root's installation record.
 */
export type WorkbenchInstallationPhase = "cloning" | "setup" | "ready";
export interface WorkbenchInstallationRecordValue {
  version: 1;
  root: string;
  phase: WorkbenchInstallationPhase;
}
export default class WorkbenchInstallationRecord {
  constructor(options: { dataRoot: string });
  readonly path: string;
  read(): Promise<WorkbenchInstallationRecordValue | null>;
  write(record: WorkbenchInstallationRecordValue): Promise<void>;
  lock(): Promise<{ close(): void }>;
}
