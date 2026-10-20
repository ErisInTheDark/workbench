/*
 * Exports:
 * - ThreadVisStoredBuild: the build context a stored session renders in.
 * - ThreadVisStoredSession: one stored vis session and who it runs as.
 * - ThreadVisCommand: atomic vis session starts, ends, control changes, reads and retention deletes.
 * - ThreadVisResult: the sessions, snapshot or control state one command produced.
 * - default WorkbenchThreadVisStore: own vis sessions, their start and end snapshots, and each vis file's synced control
 *   state in SQLite.
 */
import type Database from "better-sqlite3";
import { VIS_MAX_CONTROLS, type VisControls, type VisSnapshot, type VisSnapshotKind } from "workbench-shared/workbench/vis/vis-contract";

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
  /** Sets one control of the live session's file; returns no sessions when that session is not live in the thread. */
  | { kind: "setControl"; threadId: string; sessionId: string; controlId: string; value: string; updatedAt: number }
  /** The thread's control state for `path`, whichever session set it. */
  | { kind: "readControls"; threadId: string; path: string }
  | { kind: "delete"; threadIds: readonly string[] };

export interface ThreadVisResult {
  sessions: ThreadVisStoredSession[];
  snapshot: VisSnapshot | null;
  /** Filled only by `readControls`. */
  controls?: VisControls;
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
        case "setControl": {
          const row = this.database.prepare("SELECT * FROM workbench_thread_vis_sessions WHERE id = ? AND thread_id = ? AND ended_at IS NULL")
            .get(command.sessionId, command.threadId) as SessionRow | undefined;
          if (!row) return { sessions: [], snapshot: null };
          this.database.prepare(`INSERT INTO workbench_thread_vis_controls (thread_id, path, control_id, value, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT (thread_id, path, control_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
            .run(row.thread_id, row.path, command.controlId, command.value, command.updatedAt);
          this.database.prepare(`DELETE FROM workbench_thread_vis_controls WHERE thread_id = ? AND path = ? AND control_id NOT IN (
            SELECT control_id FROM workbench_thread_vis_controls WHERE thread_id = ? AND path = ? ORDER BY updated_at DESC, control_id LIMIT ?)`)
            .run(row.thread_id, row.path, row.thread_id, row.path, VIS_MAX_CONTROLS);
          return { sessions: [session(row)], snapshot: null };
        }
        case "readControls": {
          const rows = this.database.prepare("SELECT control_id, value FROM workbench_thread_vis_controls WHERE thread_id = ? AND path = ?")
            .all(command.threadId, command.path) as Array<{ control_id: string; value: string }>;
          return { sessions: [], snapshot: null, controls: Object.fromEntries(rows.map(({ control_id, value }) => [control_id, value])) };
        }
        case "delete": {
          const removeSessions = this.database.prepare("DELETE FROM workbench_thread_vis_sessions WHERE thread_id = ?");
          const removeControls = this.database.prepare("DELETE FROM workbench_thread_vis_controls WHERE thread_id = ?");
          for (const threadId of command.threadIds) {
            removeSessions.run(threadId);
            removeControls.run(threadId);
          }
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
