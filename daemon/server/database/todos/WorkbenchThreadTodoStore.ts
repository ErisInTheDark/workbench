/*
 * Exports:
 * - ThreadTodoCommand: atomic thread-todo reads and edits, each scoped to one thread; todo ids are serials within it.
 * - ThreadTodoResult: the thread's todos after one command, plus what the command changed.
 * - default WorkbenchThreadTodoStore: own per-thread follow-up todos in SQLite, handing out each thread's next serial and counting every thread's required todos.
 */
import type Database from "better-sqlite3";
import type { WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";

export type ThreadTodoCommand =
  | { kind: "list"; threadId: string }
  | { kind: "add"; threadId: string; text: string; required: boolean; at: number }
  /** Ids the thread does not have are ignored. */
  | { kind: "remove"; threadId: string; ids: readonly number[] }
  | { kind: "setRequired"; threadId: string; id: number; required: boolean }
  | { kind: "setText"; threadId: string; id: number; text: string };

export interface ThreadTodoResult {
  todos: WorkbenchThreadTodo[];
  /** The todo an add created. */
  added: WorkbenchThreadTodo | null;
  /** Ids a remove actually deleted. */
  removed: number[];
}

interface ThreadTodoRow {
  id: number;
  text: string;
  required: 0 | 1;
  created_at: number;
}

const toTodo = (row: ThreadTodoRow): WorkbenchThreadTodo => ({
  id: row.id, text: row.text, required: row.required === 1, createdAt: row.created_at,
});

export default class WorkbenchThreadTodoStore {
  constructor(private readonly database: Database.Database) {}

  /** How many required todos each thread holds; threads without any are absent. */
  requiredCounts(): Record<string, number> {
    const rows = this.database.prepare("SELECT thread_id, COUNT(*) AS count FROM workbench_thread_todos WHERE required = 1 GROUP BY thread_id")
      .all() as Array<{ thread_id: string; count: number }>;
    return Object.fromEntries(rows.map(({ thread_id: threadId, count }) => [threadId, count]));
  }

  execute(command: ThreadTodoCommand): ThreadTodoResult {
    return this.database.transaction((): ThreadTodoResult => {
      let added: WorkbenchThreadTodo | null = null;
      let removed: number[] = [];
      switch (command.kind) {
        case "list":
          break;
        case "add": {
          const text = command.text.trim();
          // The serial after the thread's highest, so the panel can show it before saving.
          const id = (this.database.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS next FROM workbench_thread_todos WHERE thread_id = ?")
            .get(command.threadId) as { next: number }).next;
          this.database.prepare("INSERT INTO workbench_thread_todos (thread_id, id, text, required, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(command.threadId, id, text, command.required ? 1 : 0, command.at);
          added = { id, text, required: command.required, createdAt: command.at };
          break;
        }
        case "remove": {
          if (!command.ids.length) break;
          removed = (this.database.prepare(`DELETE FROM workbench_thread_todos
            WHERE thread_id = ? AND id IN (SELECT value FROM json_each(?)) RETURNING id`)
            .all(command.threadId, JSON.stringify(command.ids)) as Array<{ id: number }>).map(({ id }) => id).sort((a, b) => a - b);
          break;
        }
        case "setRequired":
          this.database.prepare("UPDATE workbench_thread_todos SET required = ? WHERE thread_id = ? AND id = ?")
            .run(command.required ? 1 : 0, command.threadId, command.id);
          break;
        case "setText":
          this.database.prepare("UPDATE workbench_thread_todos SET text = ? WHERE thread_id = ? AND id = ?")
            .run(command.text.trim(), command.threadId, command.id);
          break;
      }
      const todos = (this.database.prepare("SELECT id, text, required, created_at FROM workbench_thread_todos WHERE thread_id = ? ORDER BY id")
        .all(command.threadId) as ThreadTodoRow[]).map(toTodo);
      return { todos, added, removed };
    })();
  }
}
