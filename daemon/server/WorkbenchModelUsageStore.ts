/*
 * Exports:
 * - default WorkbenchModelUsageStore: persist monotonic accepted model recency and read the past week.
 */
import type { WorkbenchHarness } from "workbench-shared/types";
import { insertRow, selectRows, updateRows, upsertRow } from "workbench-shared/database/workbench-database-statements";
import { workbenchHarnesses } from "workbench-shared/workbench/database/schema/core-schema";
import { composerModelUsage } from "./lib/workbench/database/schema/composer-profile-schema";
import type { WorkbenchComposerProfileDatabase } from "./WorkbenchComposerProfileStore";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default class WorkbenchModelUsageStore {
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly database: WorkbenchComposerProfileDatabase) {}

  record(harness: WorkbenchHarness, modelId: string, at: number): Promise<void> {
    if (this.closed || !modelId || !Number.isSafeInteger(at) || at < 0) {
      return Promise.reject(new Error("Model usage requires a model and valid timestamp."));
    }
    const write = this.pending.catch(() => undefined).then(async () => {
      while (true) {
        const [existing] = await this.database.query(selectRows(composerModelUsage, {
          where: { harness, model_id: modelId },
        }));
        if (existing?.last_used_at !== undefined && existing.last_used_at >= at) return;
        if (existing) {
          const result = await this.database.executeTransaction([
            updateRows(composerModelUsage, { last_used_at: at }, {
              harness, model_id: modelId, last_used_at: existing.last_used_at,
            }),
          ]);
          if (result.changes) return;
          continue;
        }
        try {
          await this.database.executeTransaction([
            upsertRow(workbenchHarnesses, { id: harness }, { conflictColumns: ["id"], updateColumns: ["id"] }),
            insertRow(composerModelUsage, { harness, model_id: modelId, last_used_at: at }),
          ]);
          return;
        } catch (error) {
          if (!(error instanceof Error && error.message.includes("UNIQUE constraint failed: workbench_composer_model_usage"))) {
            throw error;
          }
        }
      }
    });
    this.pending = write;
    return write;
  }

  async read(now: number) {
    await this.pending.catch(() => undefined);
    if (this.closed) throw new Error("Model usage store is closed.");
    const rows = await this.database.query(selectRows(composerModelUsage));
    return rows
      .filter(row => row.last_used_at >= now - WEEK_MS && row.last_used_at <= now)
      .sort((a, b) => b.last_used_at - a.last_used_at || a.harness.localeCompare(b.harness)
        || a.model_id.localeCompare(b.model_id))
      .map(row => ({ harness: row.harness, modelId: row.model_id, lastUsedAt: row.last_used_at }));
  }

  async dispose() {
    this.closed = true;
    await this.pending.catch(() => undefined);
  }
}
