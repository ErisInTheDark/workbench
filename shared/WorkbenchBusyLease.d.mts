/*
 * Exports:
 * - WorkbenchBusyLeaseRecord: one live process's published busy reasons.
 * - default WorkbenchBusyLease: publish one process's busy reasons as a pid-stamped data-root lease, removed when it holds none.
 * - readWorkbenchBusyLeases: list the busy leases of live processes without installed dependencies.
 */
export interface WorkbenchBusyLeaseRecord {
  holder: string;
  pid: number;
  reasons: string[];
  /** Null when a live process's lease could not be read; it still counts as busy. */
  updatedAt: number | null;
}

export default class WorkbenchBusyLease {
  constructor(options: {
    dataRoot: string;
    holder: string;
    pid?: number;
    alive?: (pid: number) => boolean;
    warn?: (message: string) => void;
  });
  /** Set or replace one reason; null clears it. */
  hold(key: string, reason: string | null): void;
  /** Synchronous, so process exit handlers can release the lease. */
  close(): void;
}

export function readWorkbenchBusyLeases(
  dataRoot: string,
  options?: { alive?: (pid: number) => boolean },
): Promise<WorkbenchBusyLeaseRecord[]>;
