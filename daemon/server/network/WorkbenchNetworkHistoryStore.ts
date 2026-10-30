/*
 * Exports:
 * - ThreadNetworkHistoryCommand: atomic reads and edits of the remote targets the user approved for this daemon's threads.
 * - default WorkbenchNetworkHistoryStore: own each requesting thread's approval history in SQLite. Presentation only: targets
 *   authorize calls against their own grants.
 */
import type Database from "better-sqlite3";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";
import {
  NetworkGrant, NetworkHistoryEntrySchema, NetworkTargetSchema, type NetworkHistoryEntry, type NetworkTarget,
} from "workbench-shared/workbench/network/network-grants";

export type ThreadNetworkHistoryCommand =
  | { kind: "read"; threadId: string }
  /** Re-approving a target reactivates its entry. */
  | { kind: "record"; threadId: string; id: string; approvedAt: number; target: NetworkTarget }
  | { kind: "revoke"; threadId: string; entryId: string; revokedAt: number };

interface HistoryRow {
  id: string;
  thread_id: string;
  target: string;
  approved_at: number;
  revoked_at: number | null;
}

export default class WorkbenchNetworkHistoryStore {
  constructor(private readonly database: Database.Database) {}

  execute(command: ThreadNetworkHistoryCommand): NetworkHistoryEntry[] {
    return this.database.transaction(() => {
      if (command.kind === "record") {
        const existing = this.readOne(command.threadId).find(entry => NetworkGrant.sameTarget(entry.target, command.target));
        if (existing) {
          this.database.prepare("UPDATE workbench_thread_network_history SET approved_at = ?, revoked_at = NULL, target = ? WHERE id = ?")
            .run(command.approvedAt, JSON.stringify(command.target), existing.id);
        } else {
          this.database.prepare(`INSERT INTO workbench_thread_network_history (id, thread_id, target_daemon_id, target, approved_at, revoked_at)
            VALUES (?, ?, ?, ?, ?, NULL)`).run(command.id, command.threadId, command.target.daemonId, JSON.stringify(command.target),
            command.approvedAt);
        }
      }
      if (command.kind === "revoke") {
        this.database.prepare(`UPDATE workbench_thread_network_history SET revoked_at = ?
          WHERE id = ? AND thread_id = ? AND revoked_at IS NULL`).run(command.revokedAt, command.entryId, command.threadId);
      }
      return this.readOne(command.threadId);
    })();
  }

  /** Each listed thread's history in approval order; threads without any are absent. */
  readMany(threadIds: readonly string[]): Map<string, NetworkHistoryEntry[]> {
    const rows = this.database.prepare(`SELECT id, thread_id, target, approved_at, revoked_at FROM workbench_thread_network_history
      WHERE thread_id IN (SELECT value FROM json_each(?)) ORDER BY thread_id, approved_at`).all(JSON.stringify(threadIds)) as HistoryRow[];
    return new Map([...Map.groupBy(rows, row => row.thread_id)].map(([threadId, entries]) => [threadId, entries.flatMap(toEntry)]));
  }

  /** Every thread's networked daemons, revoked or not; threads without any are absent. */
  daemonIds(): Record<string, string[]> {
    const rows = this.database.prepare(`SELECT DISTINCT thread_id, target_daemon_id FROM workbench_thread_network_history
      ORDER BY thread_id, target_daemon_id`).all() as Array<{ thread_id: string; target_daemon_id: string }>;
    return Object.fromEntries([...Map.groupBy(rows, row => row.thread_id)]
      .map(([threadId, entries]) => [threadId, entries.map(entry => entry.target_daemon_id)]));
  }

  private readOne(threadId: string) {
    return this.readMany([threadId]).get(threadId) ?? [];
  }
}

function toEntry(row: HistoryRow): NetworkHistoryEntry[] {
  let target: unknown = null;
  try { target = JSON.parse(row.target); } catch { /* A corrupt row drops only itself. */ }
  const parsed = conformToZodSchema(NetworkTargetSchema.nullable(), target, null).data;
  if (!parsed) return [];
  return [NetworkHistoryEntrySchema.parse({ id: row.id, target: parsed, approvedAt: row.approved_at, revokedAt: row.revoked_at })];
}
