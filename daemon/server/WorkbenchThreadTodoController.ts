/*
 * Exports:
 * - WorkbenchThreadTodosOptions: persistence, thread resolution and runtime publication ports.
 * - default WorkbenchThreadTodoController: own each thread's follow-up todos for agents (wb todo) and the browser.
 */
import type { WorkbenchThreadId } from "workbench-shared/workbench/identity";
import { WorkbenchThreadTodoTextSchema, type WorkbenchThreadTodo } from "workbench-shared/workbench/thread/thread-todo";
import type { ThreadTodoCommand, ThreadTodoResult } from "./database/todos/WorkbenchThreadTodoStore";

export interface WorkbenchThreadTodosOptions {
  store(command: ThreadTodoCommand): Promise<ThreadTodoResult>;
  /** The canonical Workbench thread behind a reference; null when unknown. */
  resolve(threadId: string): Promise<WorkbenchThreadId | null>;
  /** The thread's todos changed; observers show the new list. */
  changed(threadId: WorkbenchThreadId, todos: WorkbenchThreadTodo[]): void;
  now?(): number;
}

function describe(todo: WorkbenchThreadTodo) {
  return `#${todo.id} ${todo.required ? "required" : "optional"}\n${todo.text}`;
}

export default class WorkbenchThreadTodoController {
  constructor(private readonly options: WorkbenchThreadTodosOptions) {}

  async read(threadId: string) {
    const resolved = await this.options.resolve(threadId);
    return resolved ? (await this.options.store({ kind: "list", threadId: resolved })).todos : [];
  }

  async add(threadId: string, text: string, required: boolean) {
    const result = await this.#change(threadId, resolved => ({
      kind: "add", threadId: resolved, text: WorkbenchThreadTodoTextSchema.parse(text), required, at: this.options.now?.() ?? Date.now(),
    }));
    return result.added!;
  }

  async remove(threadId: string, ids: readonly number[]) {
    return (await this.#change(threadId, resolved => ({ kind: "remove", threadId: resolved, ids }))).removed;
  }

  async setRequired(threadId: string, id: number, required: boolean) {
    await this.#change(threadId, resolved => ({ kind: "setRequired", threadId: resolved, id, required }));
  }

  async setText(threadId: string, id: number, text: string) {
    const parsed = WorkbenchThreadTodoTextSchema.parse(text);
    await this.#change(threadId, resolved => ({ kind: "setText", threadId: resolved, id, text: parsed }));
  }

  /** Agent-facing text for `wb todo`. */
  async renderList(threadId: string) {
    const todos = await this.read(threadId);
    return todos.length ? `${todos.map(describe).join("\n\n")}\n` : "No todos for this thread.\n";
  }

  async renderAdd(threadId: string, text: string, required: boolean) {
    const todo = await this.add(threadId, text, required);
    return `Added todo ${todo.id} (${todo.required ? "required" : "optional"}).\n`;
  }

  async renderRemove(threadId: string, ids: readonly number[]) {
    const removed = await this.remove(threadId, ids);
    const missing = ids.filter(id => !removed.includes(id));
    return [
      removed.length ? `Removed todo${removed.length === 1 ? "" : "s"} ${removed.join(", ")}.` : "",
      missing.length ? `No todo${missing.length === 1 ? "" : "s"} ${missing.join(", ")} on this thread.` : "",
    ].filter(Boolean).join("\n") + "\n";
  }

  async #change(threadId: string, command: (resolved: WorkbenchThreadId) => ThreadTodoCommand) {
    const resolved = await this.options.resolve(threadId);
    if (!resolved) throw new Error("This thread is unknown to Workbench.");
    const result = await this.options.store(command(resolved));
    this.options.changed(resolved, result.todos);
    return result;
  }
}
