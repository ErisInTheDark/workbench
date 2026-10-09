/*
 * Exports:
 * - ThreadAddressedFeedbackCommand: atomic reads and edits of the feedback one thread was launched to address.
 * - default WorkbenchThreadAddressedFeedbackStore: own each thread's addressed feedback references in SQLite.
 */
import type Database from "better-sqlite3";
import type { WorkbenchThreadAddressedFeedback } from "workbench-shared/workbench/thread/thread-addressed-feedback";

export type ThreadAddressedFeedbackCommand =
  | { kind: "read"; threadId: string }
  /** Re-recording a report already addressed by the thread keeps its first position. */
  | { kind: "record"; threadId: string; feedback: readonly WorkbenchThreadAddressedFeedback[] }
  | { kind: "clear"; threadId: string };

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
      if (command.kind === "clear") {
        this.database.prepare("DELETE FROM workbench_thread_addressed_feedback WHERE thread_id = ?").run(command.threadId);
      }
      return (this.database.prepare(`SELECT source_daemon_id, feedback_id, category, title, author, thread_label, report, created_at
        FROM workbench_thread_addressed_feedback WHERE thread_id = ? ORDER BY position`).all(command.threadId) as AddressedRow[])
        .map((row): WorkbenchThreadAddressedFeedback => ({
          kind: "feedback", id: row.feedback_id, daemonId: row.source_daemon_id, category: row.category, title: row.title,
          author: row.author, thread: row.thread_label, createdAt: row.created_at, report: row.report,
        }));
    })();
  }
}
