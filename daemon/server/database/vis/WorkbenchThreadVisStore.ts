/*
 * Exports:
 * - ThreadVisStoredSession: one stored vis session and who it runs as.
 * - ThreadVisCommand: atomic vis session starts, ends, reads and retention deletes.
 * - ThreadVisResult: the sessions and snapshot one command produced.
 * - default WorkbenchThreadVisStore: own vis sessions and their start and end snapshots in SQLite.
 */
import type Database from "better-sqlite3";
import type { VisSnapshot, VisSnapshotKind, VisUserEnded } from "workbench-shared/workbench/vis/vis-contract";

export interface ThreadVisStoredSession {
  sessionId: string;
  threadId: string;
  harness: string;
  cwd: string;
  projectId: string;
  path: string;
  startedAt: number;
  endedAt: number | null;
}

interface CapturedDocument { capturedAt: number; document: string | null; failure: string | null }

export type ThreadVisCommand =
  | { kind: "start"; session: Omit<ThreadVisStoredSession, "endedAt">; snapshot: CapturedDocument }
  /** Ends the thread's live session on `path`; nothing happens when none is live. */
  | { kind: "end"; threadId: string; path: string; endedBy: "agent" | "user"; snapshot: CapturedDocument }
  | { kind: "readActive" }
  | { kind: "readUserEnded"; threadId: string }
  | { kind: "readSnapshot"; sessionId: string; snapshotKind: VisSnapshotKind }
  | { kind: "delete"; threadIds: readonly string[] };

export interface ThreadVisResult {
  sessions: ThreadVisStoredSession[];
  snapshot: VisSnapshot | null;
  /** Sessions the user ended, oldest first; filled only by `readUserEnded`. */
  userEnded?: VisUserEnded[];
}

interface SessionRow {
  id: string; thread_id: string; harness: string; cwd: string; project_id: string; path: string;
  started_at: number; ended_at: number | null;
}

function session(row: SessionRow): ThreadVisStoredSession {
  return {
    sessionId: row.id, threadId: row.thread_id, harness: row.harness, cwd: row.cwd, projectId: row.project_id,
    path: row.path, startedAt: row.started_at, endedAt: row.ended_at,
  };
}

export default class WorkbenchThreadVisStore {
  constructor(private readonly database: Database.Database) {}

  execute(command: ThreadVisCommand): ThreadVisResult {
    return this.database.transaction((): ThreadVisResult => {
      switch (command.kind) {
        case "start": {
          const { session: value, snapshot } = command;
          if (this.#active(value.threadId, value.path)) throw new Error(`A vis session is already live on ${value.path}; end it first.`);
          this.database.prepare(`INSERT INTO workbench_thread_vis_sessions
            (id, thread_id, harness, cwd, project_id, path, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
            .run(value.sessionId, value.threadId, value.harness, value.cwd, value.projectId, value.path, value.startedAt);
          this.#snapshot(value.sessionId, "start", snapshot);
          return { sessions: [{ ...value, endedAt: null }], snapshot: null };
        }
        case "end": {
          const row = this.#active(command.threadId, command.path);
          if (!row) return { sessions: [], snapshot: null };
          this.database.prepare("UPDATE workbench_thread_vis_sessions SET ended_at = ?, ended_by = ? WHERE id = ?")
            .run(command.snapshot.capturedAt, command.endedBy, row.id);
          this.#snapshot(row.id, "end", command.snapshot);
          return { sessions: [session({ ...row, ended_at: command.snapshot.capturedAt })], snapshot: null };
        }
        case "readActive":
          return {
            sessions: (this.database.prepare("SELECT * FROM workbench_thread_vis_sessions WHERE ended_at IS NULL ORDER BY started_at")
              .all() as SessionRow[]).map(session),
            snapshot: null,
          };
        case "readUserEnded":
          return {
            sessions: [], snapshot: null,
            userEnded: (this.database.prepare(`SELECT id, path, ended_at FROM workbench_thread_vis_sessions
              WHERE thread_id = ? AND ended_by = 'user' ORDER BY ended_at`).all(command.threadId) as
              Array<{ id: string; path: string; ended_at: number }>)
              .map(({ id, path, ended_at }) => ({ sessionId: id, path, endedAt: ended_at })),
          };
        case "readSnapshot": {
          const row = this.database.prepare(`SELECT s.path, v.captured_at, v.document, v.failure
            FROM workbench_thread_vis_snapshots v JOIN workbench_thread_vis_sessions s ON s.id = v.session_id
            WHERE v.session_id = ? AND v.kind = ?`).get(command.sessionId, command.snapshotKind) as
            { path: string; captured_at: number; document: string | null; failure: string | null } | undefined;
          return {
            sessions: [],
            snapshot: row ? {
              sessionId: command.sessionId, kind: command.snapshotKind, path: row.path,
              capturedAt: row.captured_at, document: row.document, failure: row.failure,
            } : null,
          };
        }
        case "delete": {
          const remove = this.database.prepare("DELETE FROM workbench_thread_vis_sessions WHERE thread_id = ?");
          for (const threadId of command.threadIds) remove.run(threadId);
          return { sessions: [], snapshot: null };
        }
      }
    })();
  }

  #active(threadId: string, path: string) {
    return this.database.prepare("SELECT * FROM workbench_thread_vis_sessions WHERE thread_id = ? AND path = ? AND ended_at IS NULL")
      .get(threadId, path) as SessionRow | undefined;
  }

  #snapshot(sessionId: string, kind: VisSnapshotKind, snapshot: CapturedDocument) {
    this.database.prepare(`INSERT INTO workbench_thread_vis_snapshots (session_id, kind, captured_at, document, failure)
      VALUES (?, ?, ?, ?, ?)`).run(sessionId, kind, snapshot.capturedAt, snapshot.document, snapshot.failure);
  }
}
