/*
 * Exports:
 * - ThreadGoalNotice: undelivered agent notice kinds.
 * - ThreadGoalCommand: atomic thread-goal reads and transitions.
 * - ThreadGoalState: the current goal plus its undelivered notice after one command.
 * - default WorkbenchThreadGoalStore: own per-thread user-set goals and their notice lifecycle in SQLite.
 */
import type Database from "better-sqlite3";
import type { WorkbenchThreadGoal } from "workbench-shared/workbench/thread/thread-goal";

export type ThreadGoalNotice = "updated" | "cleared" | "redeliver";

export type ThreadGoalCommand =
  | { kind: "read"; threadId: string }
  | { kind: "set"; threadId: string; objective: string; at: number }
  | { kind: "clear"; threadId: string; at: number }
  | { kind: "markCompacted"; threadId: string }
  /** Clears only the notice that was delivered; a newer transition (later `updatedAt`) survives. */
  | { kind: "acknowledge"; threadId: string; notice: ThreadGoalNotice; updatedAt: number };

export interface ThreadGoalState {
  goal: WorkbenchThreadGoal | null;
  pending: { notice: ThreadGoalNotice; objective: string | null; updatedAt: number } | null;
}

interface ThreadGoalRow {
  objective: string | null;
  pending_notice: string | null;
  updated_at: number;
}

function isNotice(value: string | null): value is ThreadGoalNotice {
  return value === "updated" || value === "cleared" || value === "redeliver";
}

export default class WorkbenchThreadGoalStore {
  constructor(private readonly database: Database.Database) {}

  execute(command: ThreadGoalCommand): ThreadGoalState {
    return this.database.transaction((): ThreadGoalState => {
      const row = this.#row(command.threadId);
      // Every transition gets a strictly newer stamp, so acknowledgement can tell deliveries apart.
      const stamp = (at: number) => Math.max(at, (row?.updated_at ?? 0) + 1);
      switch (command.kind) {
        case "read":
          break;
        case "set": {
          const objective = command.objective.trim();
          if (row?.objective === objective) break;
          this.database.prepare(`INSERT INTO workbench_thread_goals (thread_id, objective, pending_notice, updated_at)
            VALUES (?, ?, 'updated', ?) ON CONFLICT(thread_id) DO UPDATE SET
              objective = excluded.objective, pending_notice = 'updated', updated_at = excluded.updated_at`)
            .run(command.threadId, objective, stamp(command.at));
          break;
        }
        case "clear":
          if (row?.objective === null || !row) break;
          this.database.prepare(`UPDATE workbench_thread_goals SET objective = NULL, pending_notice = 'cleared', updated_at = ?
            WHERE thread_id = ?`).run(stamp(command.at), command.threadId);
          break;
        case "markCompacted":
          // An undelivered update already carries the whole objective.
          this.database.prepare(`UPDATE workbench_thread_goals SET pending_notice = 'redeliver'
            WHERE thread_id = ? AND objective IS NOT NULL AND (pending_notice IS NULL OR pending_notice <> 'updated')`)
            .run(command.threadId);
          break;
        case "acknowledge":
          if (!row || row.pending_notice !== command.notice || row.updated_at !== command.updatedAt) break;
          if (row.objective === null) {
            this.database.prepare("DELETE FROM workbench_thread_goals WHERE thread_id = ?").run(command.threadId);
          } else {
            this.database.prepare("UPDATE workbench_thread_goals SET pending_notice = NULL WHERE thread_id = ?").run(command.threadId);
          }
          break;
      }
      return this.#state(this.#row(command.threadId));
    })();
  }

  #row(threadId: string) {
    return this.database.prepare(`SELECT objective, pending_notice, updated_at FROM workbench_thread_goals WHERE thread_id = ?`)
      .get(threadId) as ThreadGoalRow | undefined;
  }

  #state(row: ThreadGoalRow | undefined): ThreadGoalState {
    if (!row) return { goal: null, pending: null };
    return {
      goal: row.objective === null ? null : { objective: row.objective, updatedAt: row.updated_at },
      pending: isNotice(row.pending_notice) ? { notice: row.pending_notice, objective: row.objective, updatedAt: row.updated_at } : null,
    };
  }
}
