/*
 * Exports:
 * - ThreadInstructionSelectionCommand: read or record one thread's instruction selection.
 * - default WorkbenchThreadInstructionSelectionStore: own each thread's last chosen instruction selection in SQLite.
 */
import type Database from "better-sqlite3";
import {
  WorkbenchInstructionSelectionSchema, type WorkbenchInstructionSelection,
} from "workbench-shared/workbench/provider/provider-input";
import { conformToZodSchema } from "workbench-shared/workbench/zod-schema-conformer";

export type ThreadInstructionSelectionCommand =
  | { kind: "read"; threadId: string }
  | { kind: "record"; threadId: string; selection: WorkbenchInstructionSelection; at: number };

export default class WorkbenchThreadInstructionSelectionStore {
  constructor(private readonly database: Database.Database) {}

  execute(command: ThreadInstructionSelectionCommand): WorkbenchInstructionSelection | null {
    if (command.kind === "record") {
      this.database.prepare(`INSERT INTO workbench_thread_instruction_selections (thread_id, selection_json, updated_at)
        VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET selection_json = excluded.selection_json, updated_at = excluded.updated_at`)
        .run(command.threadId, JSON.stringify(command.selection), command.at);
      return command.selection;
    }
    const row = this.database.prepare(`SELECT selection_json FROM workbench_thread_instruction_selections WHERE thread_id = ?`)
      .get(command.threadId) as { selection_json: string } | undefined;
    if (!row) return null;
    let stored: unknown;
    try {
      stored = JSON.parse(row.selection_json);
    } catch {
      return null;
    }
    return conformToZodSchema(WorkbenchInstructionSelectionSchema, stored, {}).data;
  }
}
