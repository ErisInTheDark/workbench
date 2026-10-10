/*
 * Exports:
 * - ThreadVisStoredBuild: the build context a stored session renders in.
 * - ThreadVisStoredSession: one stored vis session and who it runs as.
 * - ThreadVisCommand: atomic vis session starts, ends, answers, reads and retention deletes.
 * - ThreadVisResult: the sessions, snapshot or answers one command produced.
 * - default WorkbenchThreadVisStore: own vis sessions, their start and end snapshots, and their answers in SQLite.
 */
import type Database from "better-sqlite3";
import type { VisAnswer, VisSnapshot, VisSnapshotKind } from "workbench-shared/workbench/vis/vis-contract";

/** Answers kept per session; older ones are dropped as new ones arrive. */
const ANSWERS_PER_SESSION = 100;

export type ThreadVisStoredBuild = { kind: "caller" } | { kind: "folder"; root: string } | { kind: "kit" };

export interface ThreadVisStoredSession {
  sessionId: string;
  threadId: string;
  harness: string;
  cwd: string;
  projectId: string;
  path: string;
  build: ThreadVisStoredBuild;
  startedAt: number;
  endedAt: number | null;
}

interface CapturedDocument { capturedAt: number; document: string | null; failure: string | null }

export type ThreadVisCommand =
  | { kind: "start"; session: Omit<ThreadVisStoredSession, "endedAt">; snapshot: CapturedDocument }
  /** Ends the thread's live session on `path`; nothing happens when none is live. */
  | { kind: "end"; threadId: string; path: string; endedBy: "agent" | "user"; snapshot: CapturedDocument }
  | { kind: "readActive" }
  | { kind: "readSnapshot"; sessionId: string; snapshotKind: VisSnapshotKind }
  /** Records one answer for a live session of the thread; returns no sessions when it is not live. */
  | { kind: "answer"; threadId: string; sessionId: string; sentAt: number; value: string }
  /** Answers of the thread's newest session on `path`, live or ended, oldest first. */
  | { kind: "readAnswers"; threadId: string; path: string }
  | { kind: "delete"; threadIds: readonly string[] };

export interface ThreadVisResult {
  sessions: ThreadVisStoredSession[];
  snapshot: VisSnapshot | null;
  /** Filled only by `readAnswers`. */
  answers?: VisAnswer[];
}

interface SessionRow {
  id: string; thread_id: string; harness: string; cwd: string; project_id: string; path: string;
  build_kind: "caller" | "folder" | "default" | null; build_root: string | null;
  started_at: number; ended_at: number | null;
}

/** Release 75 stores the kit context as `default`, its name before it became `kit`. */
function build(row: SessionRow): ThreadVisStoredBuild {
  if (row.build_kind === "default") return { kind: "kit" };
  return row.build_kind === "folder" && row.build_root ? { kind: "folder", root: row.build_root } : { kind: "caller" };
}

function session(row: SessionRow): ThreadVisStoredSession {
  return {
    sessionId: row.id, threadId: row.thread_id, harness: row.harness, cwd: row.cwd, projectId: row.project_id,
    path: row.path, build: build(row), startedAt: row.started_at, endedAt: row.ended_at,
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
            (id, thread_id, harness, cwd, project_id, path, build_kind, build_root, started_at, ended_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
            .run(
              value.sessionId, value.threadId, value.harness, value.cwd, value.projectId, value.path,
              value.build.kind === "kit" ? "default" : value.build.kind, value.build.kind === "folder" ? value.build.root : null, value.startedAt,
            );
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
        case "answer": {
          const row = this.database.prepare("SELECT * FROM workbench_thread_vis_sessions WHERE id = ? AND thread_id = ? AND ended_at IS NULL")
            .get(command.sessionId, command.threadId) as SessionRow | undefined;
          if (!row) return { sessions: [], snapshot: null };
          const { next } = this.database.prepare(`SELECT COALESCE(MAX(sequence), -1) + 1 AS next
            FROM workbench_thread_vis_answers WHERE session_id = ?`).get(row.id) as { next: number };
          this.database.prepare("INSERT INTO workbench_thread_vis_answers (session_id, sequence, sent_at, value) VALUES (?, ?, ?, ?)")
            .run(row.id, next, command.sentAt, command.value);
          this.database.prepare("DELETE FROM workbench_thread_vis_answers WHERE session_id = ? AND sequence <= ?")
            .run(row.id, next - ANSWERS_PER_SESSION);
          return { sessions: [session(row)], snapshot: null };
        }
        case "readAnswers": {
          const row = this.database.prepare(`SELECT id FROM workbench_thread_vis_sessions
            WHERE thread_id = ? AND path = ? ORDER BY started_at DESC LIMIT 1`).get(command.threadId, command.path) as { id: string } | undefined;
          const answers = row ? (this.database.prepare(`SELECT sent_at, value FROM workbench_thread_vis_answers
            WHERE session_id = ? ORDER BY sequence`).all(row.id) as Array<{ sent_at: number; value: string }>)
            .map(({ sent_at, value }) => ({ sessionId: row.id, sentAt: sent_at, value })) : [];
          return { sessions: [], snapshot: null, answers };
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
