/*
 * Exports:
 * - ThreadSkillNotice: undelivered agent notice kinds.
 * - ThreadSkillActivation: one skill a thread activates.
 * - ThreadSkillCommand: atomic thread-skill reads and transitions.
 * - ThreadSkillState: active skills plus undelivered notices after one command.
 * - default WorkbenchThreadSkillStore: own per-thread active skills and their notice lifecycle in SQLite, and read many threads' active skills at once.
 */
import type Database from "better-sqlite3";
import type { WorkbenchThreadSkill, WorkbenchThreadSkillSource } from "workbench-shared/workbench/thread/thread-skill-state";

/** `deliver`: activated by user input and not yet sent; `redeliver`: re-send after compaction. */
export type ThreadSkillNotice = "deliver" | "redeliver" | "deactivated";

export interface ThreadSkillActivation {
  path: string;
  name: string;
  source: WorkbenchThreadSkillSource;
}

export type ThreadSkillCommand =
  | { kind: "read"; threadId: string }
  /** `deliver`: the body is still owed to the agent; false when the activation itself carried it. */
  | { kind: "activate"; threadId: string; skills: readonly ThreadSkillActivation[]; at: number; deliver: boolean }
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
          // Reactivation replaces any undelivered notice and moves the skill to the top instruction layer.
          const upsert = this.database.prepare(`INSERT INTO workbench_thread_skills
            (thread_id, path, name, source, activated_at, active, pending_notice) VALUES (?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(thread_id, path) DO UPDATE SET name = excluded.name, source = excluded.source,
              activated_at = excluded.activated_at, active = 1, pending_notice = excluded.pending_notice`);
          const notice = command.deliver ? "deliver" : null;
          for (const skill of command.skills) upsert.run(command.threadId, skill.path, skill.name, skill.source, command.at, notice);
          break;
        }
        case "deactivate":
          this.database.prepare(`UPDATE workbench_thread_skills SET active = 0, pending_notice = 'deactivated'
            WHERE thread_id = ? AND path = ? AND active = 1`).run(command.threadId, command.path);
          break;
        case "markCompacted":
          // A skill whose first delivery is still owed keeps it; that delivery already carries the body.
          this.database.prepare(`UPDATE workbench_thread_skills SET pending_notice = 'redeliver'
            WHERE thread_id = ? AND active = 1 AND pending_notice IS NULL`).run(command.threadId);
          break;
        case "acknowledge": {
          const statement = command.notice === "deactivated"
            ? this.database.prepare(`DELETE FROM workbench_thread_skills
              WHERE thread_id = ? AND path = ? AND active = 0 AND pending_notice = 'deactivated'`)
            : this.database.prepare(`UPDATE workbench_thread_skills SET pending_notice = NULL
              WHERE thread_id = ? AND path = ? AND active = 1 AND pending_notice = ?`);
          for (const path of command.paths) {
            if (command.notice === "deactivated") statement.run(command.threadId, path);
            else statement.run(command.threadId, path, command.notice);
          }
          break;
        }
      }
      return this.#read(command.threadId);
    })();
  }

  /** Each listed thread's active skills in one read, in activation order; threads without any are absent. */
  readMany(threadIds: readonly string[]): Map<string, WorkbenchThreadSkill[]> {
    const rows = this.database.prepare(`SELECT thread_id, path, name, source, activated_at, active, pending_notice
      FROM workbench_thread_skills WHERE active = 1 AND thread_id IN (SELECT value FROM json_each(?))
      ORDER BY thread_id, activated_at, path`).all(JSON.stringify(threadIds)) as Array<ThreadSkillRow & { thread_id: string }>;
    return new Map([...Map.groupBy(rows, row => row.thread_id)].map(([threadId, skills]) => [threadId, skills.map(toSkill)]));
  }

  #read(threadId: string): ThreadSkillState {
    const rows = this.database.prepare(`SELECT path, name, source, activated_at, active, pending_notice
      FROM workbench_thread_skills WHERE thread_id = ? ORDER BY activated_at, path`).all(threadId) as ThreadSkillRow[];
    return {
      skills: rows.filter(row => row.active === 1).map(toSkill),
      pending: {
        deliver: rows.filter(row => row.active === 1 && row.pending_notice === "deliver").map(toSkill),
        redeliver: rows.filter(row => row.active === 1 && row.pending_notice === "redeliver").map(toSkill),
        deactivated: rows.filter(row => row.active === 0 && row.pending_notice === "deactivated").map(toSkill),
      },
    };
  }
}
