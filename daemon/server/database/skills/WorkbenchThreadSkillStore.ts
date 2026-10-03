/*
 * Exports:
 * - ThreadSkillNotice: undelivered agent notice kinds.
 * - ThreadSkillActivation: one skill a thread activates.
 * - ThreadSkillCommand: atomic thread-skill reads and transitions.
 * - ThreadSkillState: active skills plus undelivered notices after one command.
 * - default WorkbenchThreadSkillStore: own per-thread active skills and their notice lifecycle in SQLite.
 */
import type Database from "better-sqlite3";
import type { WorkbenchThreadSkill, WorkbenchThreadSkillSource } from "workbench-shared/workbench/thread/thread-skill-state";

export type ThreadSkillNotice = "redeliver" | "deactivated";

export interface ThreadSkillActivation {
  path: string;
  name: string;
  source: WorkbenchThreadSkillSource;
}

export type ThreadSkillCommand =
  | { kind: "read"; threadId: string }
  | { kind: "activate"; threadId: string; skills: readonly ThreadSkillActivation[]; at: number }
  | { kind: "deactivate"; threadId: string; path: string }
  | { kind: "markCompacted"; threadId: string }
  /** Clears only the notices that were actually delivered; newer transitions survive. */
  | { kind: "acknowledge"; threadId: string; notice: ThreadSkillNotice; paths: readonly string[] };

export interface ThreadSkillState {
  skills: WorkbenchThreadSkill[];
  pending: Record<ThreadSkillNotice, WorkbenchThreadSkill[]>;
}

interface ThreadSkillRow {
  path: string;
  name: string;
  source: string;
  activated_at: number;
  active: number;
  pending_notice: string | null;
}

function toSkill(row: ThreadSkillRow): WorkbenchThreadSkill {
  return { path: row.path, name: row.name, source: row.source === "agent" ? "agent" : "user", activatedAt: row.activated_at };
}

export default class WorkbenchThreadSkillStore {
  constructor(private readonly database: Database.Database) {}

  execute(command: ThreadSkillCommand): ThreadSkillState {
    return this.database.transaction((): ThreadSkillState => {
      switch (command.kind) {
        case "read":
          break;
        case "activate": {
          // Reactivation cancels any undelivered notice; the activation itself carries the body.
          const upsert = this.database.prepare(`INSERT INTO workbench_thread_skills
            (thread_id, path, name, source, activated_at, active, pending_notice) VALUES (?, ?, ?, ?, ?, 1, NULL)
            ON CONFLICT(thread_id, path) DO UPDATE SET name = excluded.name, source = excluded.source,
              activated_at = CASE WHEN workbench_thread_skills.active = 1 THEN workbench_thread_skills.activated_at ELSE excluded.activated_at END,
              active = 1, pending_notice = NULL`);
          for (const skill of command.skills) upsert.run(command.threadId, skill.path, skill.name, skill.source, command.at);
          break;
        }
        case "deactivate":
          this.database.prepare(`UPDATE workbench_thread_skills SET active = 0, pending_notice = 'deactivated'
            WHERE thread_id = ? AND path = ? AND active = 1`).run(command.threadId, command.path);
          break;
        case "markCompacted":
          this.database.prepare(`UPDATE workbench_thread_skills SET pending_notice = 'redeliver'
            WHERE thread_id = ? AND active = 1`).run(command.threadId);
          break;
        case "acknowledge": {
          const statement = command.notice === "deactivated"
            ? this.database.prepare(`DELETE FROM workbench_thread_skills
              WHERE thread_id = ? AND path = ? AND active = 0 AND pending_notice = 'deactivated'`)
            : this.database.prepare(`UPDATE workbench_thread_skills SET pending_notice = NULL
              WHERE thread_id = ? AND path = ? AND active = 1 AND pending_notice = 'redeliver'`);
          for (const path of command.paths) statement.run(command.threadId, path);
          break;
        }
      }
      return this.#read(command.threadId);
    })();
  }

  #read(threadId: string): ThreadSkillState {
    const rows = this.database.prepare(`SELECT path, name, source, activated_at, active, pending_notice
      FROM workbench_thread_skills WHERE thread_id = ? ORDER BY activated_at, path`).all(threadId) as ThreadSkillRow[];
    return {
      skills: rows.filter(row => row.active === 1).map(toSkill),
      pending: {
        redeliver: rows.filter(row => row.active === 1 && row.pending_notice === "redeliver").map(toSkill),
        deactivated: rows.filter(row => row.active === 0 && row.pending_notice === "deactivated").map(toSkill),
      },
    };
  }
}
