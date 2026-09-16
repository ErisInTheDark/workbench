/*
 * Exports:
 * - WorkbenchBrowseSessionRecord: persisted session ownership and activity.
 * - default WorkbenchBrowseSessionRegistry: own SQLite session catalogue mutations.
 */
import type WorkbenchDatabaseController from "../../../database/WorkbenchDatabaseController";
import type { WorkbenchBrowseSessionMode } from "workbench-shared/types";
import { deleteRows, selectRows, updateRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { browseSessions } from "../database/schema/browse-persistence-schema";

export interface WorkbenchBrowseSessionRecord {
  cwd: string | null;
  inactiveSince: string | null;
  lastActionAt: string;
  mode: WorkbenchBrowseSessionMode | null;
  name: string;
  projectId: string | null;
  projectRootPath: string | null;
  threadId: string | null;
}

export default class WorkbenchBrowseSessionRegistry {
  private writes = Promise.resolve();

  constructor(
    private readonly database: Pick<WorkbenchDatabaseController, "query" | "executeTransaction">,
    private readonly now: () => number = Date.now,
  ) {}

  async forget(name: string) {
    await this.mutate(async () => { await this.database.executeTransaction([deleteRows(browseSessions, { name })]); });
  }

  async list(): Promise<WorkbenchBrowseSessionRecord[]> {
    const rows = await this.database.query(selectRows(browseSessions));
    return rows.map(row => ({
      cwd: row.cwd, inactiveSince: row.inactive_since, lastActionAt: row.last_action_at,
      mode: row.mode, name: row.name, projectId: row.project_id, projectRootPath: row.project_root_path, threadId: row.thread_id,
    })).sort((left, right) => left.name.localeCompare(right.name));
  }

  async listByProjectId(projectId: string) {
    return (await this.list()).filter(session => session.projectId === projectId);
  }

  async listByThreadId(threadId: string) {
    return (await this.list()).filter(session => session.threadId === threadId);
  }

  async listOwnedThreadIds() {
    return [...new Set((await this.list()).flatMap(session => session.threadId ? [session.threadId] : []))].sort();
  }

  async listStaleInactiveSessions({ olderThanMs, now = this.now() }: { olderThanMs: number; now?: number }) {
    return (await this.list()).filter(session => {
      if (!session.threadId || !session.inactiveSince) return false;
      const inactiveSince = Date.parse(session.inactiveSince);
      return Number.isFinite(inactiveSince) && now - inactiveSince >= olderThanMs;
    });
  }

  async markThreadActive(threadId: string) {
    await this.mutate(async () => {
      await this.database.executeTransaction([updateRows(browseSessions, { inactive_since: null }, { thread_id: threadId })]);
    });
  }

  async markThreadInactive(threadId: string) {
    await this.mutate(async () => {
      await this.database.executeTransaction([updateRows(browseSessions, {
        inactive_since: new Date(this.now()).toISOString(),
      }, { thread_id: threadId, inactive_since: null })]);
    });
  }

  async remember(input: Omit<WorkbenchBrowseSessionRecord, "inactiveSince" | "lastActionAt" | "threadId"> & { threadId: string }) {
    await this.mutate(async () => {
      const [existing] = await this.database.query(selectRows(browseSessions, { where: { name: input.name } }));
      await this.database.executeTransaction([upsertRow(browseSessions, {
        name: input.name, cwd: input.cwd ?? existing?.cwd ?? null,
        mode: input.mode ?? existing?.mode ?? null,
        project_id: input.projectId ?? existing?.project_id ?? null,
        project_root_path: input.projectRootPath ?? existing?.project_root_path ?? null,
        thread_id: input.threadId, inactive_since: null, last_action_at: new Date(this.now()).toISOString(),
      }, {
        conflictColumns: ["name"],
        updateColumns: ["cwd", "mode", "project_id", "project_root_path", "thread_id", "inactive_since", "last_action_at"],
      })]);
    });
  }

  async touchSession(name: string) {
    await this.mutate(async () => {
      await this.database.executeTransaction([updateRows(browseSessions, { last_action_at: new Date(this.now()).toISOString() }, { name })]);
    });
  }

  private async mutate(operation: () => Promise<void>) {
    const result = this.writes.then(operation);
    this.writes = result.then(() => undefined, () => undefined);
    await result;
  }
}
