/*
 * Exports:
 * - default WorkbenchApprovalOutcomeRepository: persist and read per-tool-item approval outcomes by stable item identity.
 */
import type Database from "better-sqlite3";
import {
  WORKBENCH_APPROVAL_OUTCOMES,
  type WorkbenchApprovalOutcome,
  type WorkbenchApprovalOutcomeEntry,
} from "workbench-shared/workbench/provider/provider-approval";

type OutcomeRow = { item_id: string; thread_id: string; turn_id: string; outcome: string; resolved_at: number };

function isOutcome(value: string): value is WorkbenchApprovalOutcome {
  return (WORKBENCH_APPROVAL_OUTCOMES as readonly string[]).includes(value);
}

export default class WorkbenchApprovalOutcomeRepository {
  constructor(private readonly database: Database.Database) {}

  /** One item holds one approval; a later decision for the same item replaces the earlier one. */
  record(entry: WorkbenchApprovalOutcomeEntry) {
    this.database.prepare(`
      INSERT INTO workbench_item_approvals(item_id, thread_id, turn_id, outcome, resolved_at)
      VALUES (@itemId, @threadId, @turnId, @outcome, @resolvedAt)
      ON CONFLICT(item_id) DO UPDATE SET turn_id = excluded.turn_id, outcome = excluded.outcome, resolved_at = excluded.resolved_at
      WHERE workbench_item_approvals.thread_id = excluded.thread_id
    `).run(entry);
  }

  read(threadId: string, turnIds?: readonly string[]): WorkbenchApprovalOutcomeEntry[] {
    if (turnIds && !turnIds.length) return [];
    const rows = (turnIds
      ? this.database.prepare(`
        SELECT * FROM workbench_item_approvals
        WHERE thread_id = ? AND turn_id IN (${turnIds.map(() => "?").join(",")})
        ORDER BY resolved_at, item_id
      `).all(threadId, ...turnIds)
      : this.database.prepare("SELECT * FROM workbench_item_approvals WHERE thread_id = ? ORDER BY resolved_at, item_id")
        .all(threadId)) as OutcomeRow[];
    return rows.map(row => {
      if (!isOutcome(row.outcome)) throw new Error("Stored approval outcome is not recognised.");
      return { itemId: row.item_id, threadId: row.thread_id, turnId: row.turn_id, outcome: row.outcome, resolvedAt: row.resolved_at };
    });
  }
}
