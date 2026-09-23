/*
 * Exports:
 * - default WorkbenchThreadLaunchRepository: own immutable launch admission and durable dispatch/acceptance state.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  WorkbenchThreadLaunchRequestSchema,
  WorkbenchThreadLaunchLocationSchema,
  WorkbenchThreadLaunchStateSchema,
  type WorkbenchThreadLaunchRequest,
  type WorkbenchThreadLaunchLocation,
  type WorkbenchThreadLaunchState,
} from "workbench-shared/workbench/thread/thread-launch";
import type { ThreadLaunchRows } from "workbench-shared/workbench/database/schema/thread-launch-schema";

type LaunchRow = ThreadLaunchRows["launches"];
const storedRequestSchema = WorkbenchThreadLaunchRequestSchema.extend({
  location: WorkbenchThreadLaunchLocationSchema,
});

function signature(request: WorkbenchThreadLaunchRequest) {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export default class WorkbenchThreadLaunchRepository {
  constructor(private readonly database: Database.Database) {}

  recoverInterrupted() {
    this.database.prepare(`
      UPDATE workbench_thread_launches
      SET phase = 'unknown', reason = 'The daemon stopped while provider acceptance was unresolved.'
      WHERE phase IN ('creating', 'sending')
    `).run();
  }

  reserve(input: WorkbenchThreadLaunchRequest, location: WorkbenchThreadLaunchLocation,
    now = Date.now()): WorkbenchThreadLaunchState {
    const request = WorkbenchThreadLaunchRequestSchema.parse(input);
    const captured = WorkbenchThreadLaunchLocationSchema.parse(location);
    const hash = signature(request);
    return this.database.transaction(() => {
      const existing = this.row(request.launchId);
      if (existing) {
        if (existing.request_hash !== hash) throw new Error("Launch ID belongs to a different saved intent.");
        return this.state(this.reconcileAccepted(existing));
      }
      this.database.prepare(`
        INSERT INTO workbench_thread_launches
          (id, project_id, request_hash, request_json, phase, updated_at)
        VALUES (?, ?, ?, ?, 'prepared', ?)
      `).run(request.launchId, request.projectId, hash, JSON.stringify({ ...request, location: captured }), now);
      return this.state(this.row(request.launchId)!);
    })();
  }

  read(launchId: string): { request: WorkbenchThreadLaunchRequest;
    location: WorkbenchThreadLaunchLocation; state: WorkbenchThreadLaunchState } | null {
    return this.database.transaction(() => {
      const row = this.row(launchId);
      const stored = row ? storedRequestSchema.parse(JSON.parse(row.request_json)) : null;
      if (!row || !stored) return null;
      const { location, ...request } = stored;
      return {
        request, location,
        state: this.state(this.reconcileAccepted(row)),
      };
    })();
  }

  private reconcileAccepted(row: LaunchRow): LaunchRow {
    if (row.phase !== "unknown" || !row.thread_id) return row;
    const request = storedRequestSchema.parse(JSON.parse(row.request_json));
    const turns = this.database.prepare(`
      SELECT DISTINCT i.turn_id FROM thread_items i
      JOIN thread_item_user_messages u ON u.item_id = i.id
      WHERE i.thread_id = ? AND u.client_id = ? AND u.delivery_state = 'delivered'
      LIMIT 2
    `).all(row.thread_id, request.clientMessageId) as Array<{ turn_id: string }>;
    if (turns.length !== 1) return row;
    this.database.prepare(`
      UPDATE workbench_thread_launches
      SET phase = 'accepted', turn_id = ?, reason = NULL, updated_at = ?
      WHERE id = ? AND phase = 'unknown'
    `).run(turns[0]!.turn_id, Date.now(), row.id);
    return this.row(row.id)!;
  }

  bindCreated(launchId: string, projectId: string, threadId: string, now = Date.now()) {
    return this.database.transaction(() => {
      const current = this.row(launchId);
      if (!current || current.project_id !== projectId) throw new Error("Launch does not own the admitted project.");
      if (current.phase === "created" || current.phase === "sending" || current.phase === "accepted") {
        if (current.thread_id !== threadId) throw new Error("Launch is bound to another thread.");
        return this.state(current);
      }
      if (current.phase !== "creating") throw new Error("Launch is not admitting a created thread.");
      this.database.prepare(`
        UPDATE workbench_thread_launches SET phase = 'created', thread_id = ?, updated_at = ?
        WHERE id = ?
      `).run(threadId, now, launchId);
      return this.state(this.row(launchId)!);
    })();
  }

  advance(launchId: string, from: WorkbenchThreadLaunchState["phase"], next: WorkbenchThreadLaunchState, now = Date.now()) {
    return this.database.transaction(() => {
      const current = this.row(launchId);
      if (!current || current.phase !== from || next.launchId !== launchId) {
        throw new Error("Launch progress changed before settlement.");
      }
      this.database.prepare(`
        UPDATE workbench_thread_launches
        SET phase = ?, thread_id = ?, turn_id = ?, reason = ?, updated_at = ?
        WHERE id = ?
      `).run(next.phase, "threadId" in next ? next.threadId : null,
        next.phase === "accepted" ? next.turnId : null,
        "reason" in next ? next.reason : null, now, launchId);
      return this.state(this.row(launchId)!);
    })();
  }

  private row(id: string) {
    return this.database.prepare("SELECT * FROM workbench_thread_launches WHERE id = ?").get(id) as LaunchRow | undefined;
  }

  private state(row: LaunchRow): WorkbenchThreadLaunchState {
    return WorkbenchThreadLaunchStateSchema.parse({
      phase: row.phase, launchId: row.id,
      ...(row.phase === "created" || row.phase === "sending" || row.phase === "accepted"
        ? { threadId: row.thread_id } : {}),
      ...(row.phase === "accepted" ? { turnId: row.turn_id } : {}),
      ...(row.phase === "failed" || row.phase === "unknown" ? { reason: row.reason } : {}),
      ...(row.phase === "unknown" ? { threadId: row.thread_id } : {}),
    });
  }
}
