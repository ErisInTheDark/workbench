/*
 * Exports:
 * - threadRowLookup: index listed rows once by logical home key and by `daemonId:physical home key`; the first listing of a key wins.
 */
import type { WorkbenchLogicalThreadRow } from "workbench-shared/types";
import { getWorkbenchHomeThreadKey } from "workbench-shared/workbench/thread/home-thread-display-order";

interface ThreadRowLookup {
  logical: ReadonlyMap<string, WorkbenchLogicalThreadRow>;
  physical: ReadonlyMap<string, WorkbenchLogicalThreadRow>;
}

const lookups = new WeakMap<readonly WorkbenchLogicalThreadRow[], ThreadRowLookup>();

export function threadRowLookup(rows: readonly WorkbenchLogicalThreadRow[]): ThreadRowLookup {
  const cached = lookups.get(rows);
  if (cached) return cached;
  const logical = new Map<string, WorkbenchLogicalThreadRow>();
  const physical = new Map<string, WorkbenchLogicalThreadRow>();
  for (const row of rows) {
    const logicalKey = getWorkbenchHomeThreadKey(row.logicalProjectId, row.entry);
    const physicalKey = `${row.location.daemonId}:${getWorkbenchHomeThreadKey(row.location.projectId, row.entry)}`;
    if (!logical.has(logicalKey)) logical.set(logicalKey, row);
    if (!physical.has(physicalKey)) physical.set(physicalKey, row);
  }
  const lookup = { logical, physical };
  lookups.set(rows, lookup);
  return lookup;
}
