/*
 * Exports:
 * - ThreadAddressedFeedbackCommand: atomic reads and edits of the feedback one thread was launched to address.
 * - default WorkbenchThreadAddressedFeedbackStore: own, count and batch-read each thread's addressed feedback references in SQLite.
 */
import type Database from "better-sqlite3";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";

export type ThreadAddressedFeedbackCommand =
  | { kind: "read"; threadId: string }
  /** Re-recording a report already addressed by the thread keeps its first position. */
  | { kind: "record"; threadId: string; feedback: readonly WorkbenchThreadAddressedFeedback[] }
  | { kind: "detach"; threadId: string; daemonId: string; feedbackId: number };

interface AddressedRow {
  source_daemon_id: string;
  feedback_id: number;
  category: WorkbenchThreadAddressedFeedback["category"];
  title: string;
  author: string;
  thread_label: string;
  report: string;
  created_at: number;
}

export default class WorkbenchThreadAddressedFeedbackStore {
  constructor(private readonly database: Database.Database) {}

  /** How many feedback reports each thread addresses; threads without any are absent. */
  counts(): Record<string, number> {
    const rows = this.database.prepare("SELECT thread_id, COUNT(*) AS count FROM workbench_thread_addressed_feedback GROUP BY thread_id")
      .all() as Array<{ thread_id: string; count: number }>;
    return Object.fromEntries(rows.map(({ thread_id: threadId, count }) => [threadId, count]));
  }

  execute(command: ThreadAddressedFeedbackCommand): WorkbenchThreadAddressedFeedback[] {
    return this.database.transaction(() => {
      if (command.kind === "record" && command.feedback.length) {
        const next = (this.database.prepare("SELECT COALESCE(MAX(position) + 1, 0) AS next FROM workbench_thread_addressed_feedback WHERE thread_id = ?")
          .get(command.threadId) as { next: number }).next;
        const insert = this.database.prepare(`INSERT INTO workbench_thread_addressed_feedback
          (thread_id, source_daemon_id, feedback_id, position, category, title, author, thread_label, report, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
        command.feedback.forEach((item, index) => insert.run(
          command.threadId, item.daemonId, item.id, next + index, item.category, item.title, item.author, item.thread, item.report, item.createdAt,
        ));
      }
      if (command.kind === "detach") {
        this.database.prepare("DELETE FROM workbench_thread_addressed_feedback WHERE thread_id = ? AND source_daemon_id = ? AND feedback_id = ?")
          .run(command.threadId, command.daemonId, command.feedbackId);
      }
      return (this.database.prepare(`SELECT source_daemon_id, feedback_id, category, title, author, thread_label, report, created_at
        FROM workbench_thread_addressed_feedback WHERE thread_id = ? ORDER BY position`).all(command.threadId) as AddressedRow[])
        .map(toFeedback);
    })();
  }

  /** Each listed thread's addressed feedback in one read, in recorded order; threads without any are absent. */
  readMany(threadIds: readonly string[]): Map<string, WorkbenchThreadAddressedFeedback[]> {
    const rows = this.database.prepare(`SELECT thread_id, source_daemon_id, feedback_id, category, title, author, thread_label, report, created_at
      FROM workbench_thread_addressed_feedback WHERE thread_id IN (SELECT value FROM json_each(?)) ORDER BY thread_id, position`)
      .all(JSON.stringify(threadIds)) as Array<AddressedRow & { thread_id: string }>;
    return new Map([...Map.groupBy(rows, row => row.thread_id)].map(([threadId, feedback]) => [threadId, feedback.map(toFeedback)]));
  }
}

const toFeedback = (row: AddressedRow): WorkbenchThreadAddressedFeedback => ({
  kind: "feedback", id: row.feedback_id, daemonId: row.source_daemon_id, category: row.category, title: row.title,
  author: row.author, thread: row.thread_label, createdAt: row.created_at, report: row.report,
});
