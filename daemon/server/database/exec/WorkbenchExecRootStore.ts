/*
 * Exports:
 * - ExecRootRecord: one recorded sandboxed command root.
 * - default WorkbenchExecRootStore: record, forget and take the stale command roots of earlier executor generations.
 */
import type WorkbenchDatabaseController from "../WorkbenchDatabaseController";
import { deleteRows, selectRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { execRoots } from "../../lib/workbench/database/schema/exec-roots-schema";

export interface ExecRootRecord {
  processId: string;
  generation: string;
  pid: number;
  startedAt: string;
}

export default class WorkbenchExecRootStore {
  private writes = Promise.resolve();

  constructor(
    private readonly database: Pick<WorkbenchDatabaseController, "query" | "executeTransaction">,
    private readonly now: () => number = Date.now,
  ) {}

  /** Writes stay in arrival order, so a command's settlement never lands before its root. */
  record(root: ExecRootRecord) {
    return this.mutate(async () => {
      await this.database.executeTransaction([upsertRow(execRoots, {
        process_id: root.processId, generation: root.generation, pid: root.pid, started_at: root.startedAt, recorded_at: this.now(),
      }, { conflictColumns: ["process_id"], updateColumns: ["generation", "pid", "started_at", "recorded_at"] })]);
    });
  }

  forget(processId: string) {
    return this.mutate(async () => {
      await this.database.executeTransaction([deleteRows(execRoots, { process_id: processId })]);
    });
  }

  /** Removes and returns every root recorded by a generation other than `current`. */
  takeStale(current: string) {
    let stale: ExecRootRecord[] = [];
    return this.mutate(async () => {
      const rows = await this.database.query(selectRows(execRoots));
      stale = rows.filter(row => row.generation !== current).map(row => ({
        processId: row.process_id, generation: row.generation, pid: row.pid, startedAt: row.started_at,
      }));
      if (stale.length) await this.database.executeTransaction(stale.map(row => deleteRows(execRoots, { process_id: row.processId })));
    }).then(() => stale);
  }

  private mutate(operation: () => Promise<void>) {
    const result = this.writes.then(operation);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }
}
