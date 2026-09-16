/*
 * Exports:
 * - default WorkbenchStatsAttributionRepository: cache canonical SQLite model attribution for usage missing turn context.
 */
import type Database from "better-sqlite3";
import type { WorkbenchHarness } from "workbench-shared/types";

import {
  API_PRICING_POLICY_VERSION,
  defaultApiPricingModel,
} from "../../stats/api-pricing.ts";

interface MissingUsageRow {
  harness_id: WorkbenchHarness;
  nearest_model: string | null;
  project_model: string | null;
  thread_model: string | null;
  turn_id: string;
}

export default class WorkbenchStatsAttributionRepository {
  constructor(private readonly database: Database.Database) {}

  repair(now: number, threadId: string | null = null) {
    const rows = this.database.prepare(`
      SELECT
        u.turn_id,
        t.harness_id,
        (
          SELECT known.model
          FROM thread_turn_usage known
          JOIN thread_turns known_turn ON known_turn.id = known.turn_id
          WHERE known_turn.thread_id = t.thread_id AND known.model IS NOT NULL AND known.model != ''
          ORDER BY ABS(known_turn.turn_index - t.turn_index), known_turn.turn_index
          LIMIT 1
        ) AS nearest_model,
        profile.model AS thread_model,
        project_profile.model AS project_model
      FROM thread_turn_usage u
      JOIN thread_turns t ON t.id = u.turn_id
      JOIN workbench_threads wt ON wt.id = t.thread_id
      LEFT JOIN workbench_thread_profiles profile ON profile.thread_id = t.thread_id
        AND profile.harness_id = t.harness_id
      LEFT JOIN workbench_project_thread_profiles project_profile ON project_profile.project_id = wt.project_id
        AND project_profile.harness_id = t.harness_id
      WHERE (u.model IS NULL OR u.model = '') AND (? IS NULL OR t.thread_id = ?)
    `).all(threadId, threadId) as MissingUsageRow[];
    const upsert = this.database.prepare(`
      INSERT INTO thread_usage_model_attributions (turn_id, model, source, policy_version, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        model = excluded.model,
        source = excluded.source,
        policy_version = excluded.policy_version,
        updated_at = excluded.updated_at
    `);
    this.database.transaction(() => {
      for (const row of rows) {
        const model = row.nearest_model || row.thread_model || row.project_model || defaultApiPricingModel(row.harness_id);
        const source = row.nearest_model || row.thread_model ? "thread" : row.project_model ? "project" : "provider";
        upsert.run(row.turn_id, model, source, API_PRICING_POLICY_VERSION, now);
      }
      this.database.prepare(`
        DELETE FROM thread_usage_model_attributions
        WHERE turn_id IN (SELECT turn_id FROM thread_turn_usage WHERE model IS NOT NULL AND model != '')
      `).run();
    })();
    return rows.length;
  }
}
