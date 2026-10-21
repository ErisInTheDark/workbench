/*
 * Exports:
 * - WorkbenchTranscriptRetentionCutoffs: expiry clocks and observed threads excluded from whole-turn expiry.
 * - default WorkbenchTranscriptRetentionRepository: aggregate durable tool facts, keep expiring narrative searchable, and expire
 *   eligible result payloads in one atomic step and whole turns in bounded atomic batches.
 */
import type Database from "better-sqlite3";
import { purgeArchivedSearchNarrative, retainSearchNarrative } from "../search/WorkbenchSearchNarrativeIndex.ts";

export interface WorkbenchTranscriptRetentionCutoffs {
  expiredAt: number;
  resultCutoff: number;
  transcriptCutoff: number;
  observedThreadIds?: readonly string[];
}

const DAY_MS = 86_400_000;

export default class WorkbenchTranscriptRetentionRepository {
  constructor(private readonly database: Database.Database) {}

  /** Expires every eligible result payload and purges narrative of archived threads; returns the results expired. */
  expireResultPayloads(cutoffs: Pick<WorkbenchTranscriptRetentionCutoffs, "expiredAt" | "resultCutoff">) {
    return this.database.transaction(() => {
      const expired = this.expireResults(cutoffs.resultCutoff, cutoffs.expiredAt);
      purgeArchivedSearchNarrative(this.database);
      return expired;
    })();
  }

  /**
   * Expires at most `maxTurns` whole eligible turns as one atomic batch; returns how many it expired, so fewer than
   * `maxTurns` means none are left. Each turn's items cascade through every item table, so batches bound the writer hold.
   */
  expireTurnPayloads(cutoffs: Omit<WorkbenchTranscriptRetentionCutoffs, "resultCutoff">, maxTurns: number) {
    return this.database.transaction(() => this.expireTranscripts(
      cutoffs.transcriptCutoff, cutoffs.expiredAt, cutoffs.observedThreadIds ?? [], maxTurns,
    ))();
  }

  private aggregateCandidateResults(where: string, parameters: Record<string, number | string>) {
    this.database.prepare(`
      INSERT INTO thread_tool_daily_aggregates
        (project_id, thread_id, day, tool_name, call_count, failure_count)
      SELECT thread.project_id, item.thread_id, CAST(item.created_at / ${DAY_MS} AS INTEGER) day,
        callable.tool_name, COUNT(*), SUM(callable.state = 'failed')
      FROM thread_items item
      JOIN workbench_threads thread ON thread.id = item.thread_id
      JOIN thread_operation_callable_tool_sources callable ON callable.item_id = item.id
      LEFT JOIN thread_item_payload_retention retained ON retained.item_id = item.id
      WHERE callable.server_name IN ('wb', 'wbex')
        AND callable.state IN ('completed', 'failed')
        AND ${where}
      GROUP BY project_id, thread_id, day, tool_name
      ON CONFLICT(project_id, thread_id, day, tool_name) DO UPDATE SET
        call_count = call_count + excluded.call_count,
        failure_count = failure_count + excluded.failure_count
    `).run(parameters);
  }

  private expireResults(cutoff: number, expiredAt: number) {
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO thread_item_payload_retention(item_id, expired_at)
      SELECT item.id, @expiredAt
      FROM thread_items item
      LEFT JOIN thread_item_payload_retention retained ON retained.item_id = item.id
      LEFT JOIN thread_operation_process_sources process ON process.item_id = item.id
      LEFT JOIN thread_operation_callable_tool_sources callable ON callable.item_id = item.id
      LEFT JOIN thread_callable_mcp_results mcp ON mcp.item_id = item.id
      LEFT JOIN thread_callable_dynamic_content dynamic ON dynamic.item_id = item.id
      LEFT JOIN thread_item_tool_outputs output ON output.item_id = item.id
      WHERE retained.item_id IS NULL AND item.created_at < @cutoff AND (
        (process.output_text IS NOT NULL AND process.state NOT IN ('queued', 'inProgress'))
        OR (mcp.item_id IS NOT NULL AND callable.state IN ('completed', 'failed'))
        OR (dynamic.item_id IS NOT NULL AND callable.state IN ('completed', 'failed'))
        OR output.item_id IS NOT NULL
      )
    `).run({ cutoff, expiredAt }).changes;
    if (!inserted) return 0;
    this.aggregateCandidateResults("retained.expired_at = @expiredAt", { expiredAt });
    this.database.exec(`
      UPDATE thread_operation_process_sources SET output_text = NULL
      WHERE item_id IN (
        SELECT item_id FROM thread_item_payload_retention WHERE expired_at = ${expiredAt}
      );
      DELETE FROM thread_callable_mcp_results
      WHERE item_id IN (
        SELECT item_id FROM thread_item_payload_retention WHERE expired_at = ${expiredAt}
      );
      DELETE FROM thread_callable_dynamic_content
      WHERE item_id IN (
        SELECT item_id FROM thread_item_payload_retention WHERE expired_at = ${expiredAt}
      );
      DELETE FROM thread_tool_output_parts
      WHERE item_id IN (
        SELECT item_id FROM thread_item_payload_retention WHERE expired_at = ${expiredAt}
      );
      UPDATE thread_item_tool_outputs SET body_kind = 'text', body_text = ''
      WHERE item_id IN (
        SELECT item_id FROM thread_item_payload_retention WHERE expired_at = ${expiredAt}
      );
    `);
    return inserted;
  }

  private expireTranscripts(cutoff: number, expiredAt: number, observedThreadIds: readonly string[], maxTurns: number) {
    // Earlier batches share `expiredAt`, so this batch is addressed by its own turn ids.
    const expiring = this.database.prepare(`
      INSERT OR IGNORE INTO thread_turn_payload_retention(turn_id, expired_at)
      SELECT turn.id, @expiredAt
      FROM thread_turns turn
      JOIN workbench_thread_retention retention ON retention.thread_id = turn.thread_id
      LEFT JOIN thread_turn_payload_retention expired ON expired.turn_id = turn.id
      WHERE retention.settled_at < @cutoff AND expired.turn_id IS NULL
        AND turn.thread_id NOT IN (SELECT value FROM json_each(@observedThreadIds))
      LIMIT @maxTurns
      RETURNING turn_id
    `).pluck().all({ cutoff, expiredAt, maxTurns, observedThreadIds: JSON.stringify(observedThreadIds) });
    if (!expiring.length) return 0;
    const turnIds = JSON.stringify(expiring);
    const batch = "SELECT value FROM json_each(@turnIds)";
    this.aggregateCandidateResults(`retained.item_id IS NULL AND item.turn_id IN (${batch})`, { turnIds });
    retainSearchNarrative(this.database, "SELECT value FROM json_each(?)", [turnIds]);
    this.database.prepare(`DELETE FROM transcript_native_records WHERE turn_id IN (${batch})`).run({ turnIds });
    this.database.prepare(`DELETE FROM thread_items WHERE turn_id IN (${batch})`).run({ turnIds });
    return expiring.length;
  }
}
