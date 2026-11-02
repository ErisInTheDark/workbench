/*
 * Exports:
 * - ThreadInstructionOverlayCommand: read one thread's pinned instruction layers, replace its base layers, or merge skill layers by path.
 * - StoredThreadInstructionOverlays: the stored JSON as written; its owner validates it.
 * - default WorkbenchThreadInstructionOverlayStore: own each thread's pinned instruction layers in SQLite.
 */
import type Database from "better-sqlite3";

export type ThreadInstructionOverlayCommand =
  | { kind: "read"; threadId: string }
  | { kind: "pinBase"; threadId: string; layers: readonly object[]; at: number }
  | { kind: "pinSkills"; threadId: string; skills: Readonly<Record<string, object>>; at: number };

export interface StoredThreadInstructionOverlays {
  base: unknown;
  skills: Readonly<Record<string, unknown>>;
}

type Row = { base_json: string | null; skills_json: string };

function parse(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export default class WorkbenchThreadInstructionOverlayStore {
  constructor(private readonly database: Database.Database) {}

  execute(command: ThreadInstructionOverlayCommand): StoredThreadInstructionOverlays | null {
    if (command.kind === "pinBase") {
      this.database.prepare(`INSERT INTO workbench_thread_instruction_overlays (thread_id, base_json, skills_json, updated_at)
        VALUES (?, ?, '{}', ?) ON CONFLICT(thread_id) DO UPDATE SET base_json = excluded.base_json, updated_at = excluded.updated_at`)
        .run(command.threadId, JSON.stringify(command.layers), command.at);
      return null;
    }
    if (command.kind === "pinSkills") {
      const current = this.read(command.threadId);
      const skills = { ...current?.skills, ...command.skills };
      this.database.prepare(`INSERT INTO workbench_thread_instruction_overlays (thread_id, base_json, skills_json, updated_at)
        VALUES (?, NULL, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET skills_json = excluded.skills_json, updated_at = excluded.updated_at`)
        .run(command.threadId, JSON.stringify(skills), command.at);
      return null;
    }
    return this.read(command.threadId);
  }

  private read(threadId: string): StoredThreadInstructionOverlays | null {
    const row = this.database.prepare("SELECT base_json, skills_json FROM workbench_thread_instruction_overlays WHERE thread_id = ?")
      .get(threadId) as Row | undefined;
    return row ? { base: parse(row.base_json), skills: asRecord(parse(row.skills_json)) } : null;
  }
}
