/*
 * Exports:
 * - WorkbenchTranscriptRetentionResult: payload rows expired by one atomic pass.
 * - default WorkbenchTranscriptRetentionRepository: aggregate durable tool facts and expire eligible result/transcript payloads.
 */
import type Database from "better-sqlite3";

export interface WorkbenchTranscriptRetentionResult {
  expiredResults: number;
  expiredTurns: number;
}

export interface WorkbenchTranscriptRetentionCutoffs {
  expiredAt: number;
  resultCutoff: number;
  transcriptCutoff: number;
}

const DAY_MS = 86_400_000;

export default class WorkbenchTranscriptRetentionRepository {
  constructor(private readonly database: Database.Database) {}

  expire(cutoffs: WorkbenchTranscriptRetentionCutoffs): WorkbenchTranscriptRetentionResult {
    return this.database.transaction(() => {
      const expiredResults = this.expireResults(cutoffs.resultCutoff, cutoffs.expiredAt);
      const expiredTurns = this.expireTranscripts(cutoffs.transcriptCutoff, cutoffs.expiredAt);
      return { expiredResults, expiredTurns };
    })();
  }

  private aggregateCandidateResults(where: string, parameters: Record<string, number>) {
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

  private expireTranscripts(cutoff: number, expiredAt: number) {
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO thread_turn_payload_retention(turn_id, expired_at)
      SELECT turn.id, @expiredAt
      FROM thread_turns turn
      JOIN workbench_thread_retention retention ON retention.thread_id = turn.thread_id
      LEFT JOIN thread_turn_payload_retention expired ON expired.turn_id = turn.id
      WHERE retention.settled_at < @cutoff AND expired.turn_id IS NULL
    `).run({ cutoff, expiredAt }).changes;
    if (!inserted) return 0;
    this.aggregateCandidateResults(`
      retained.item_id IS NULL
      AND item.turn_id IN (
        SELECT turn_id FROM thread_turn_payload_retention WHERE expired_at = @expiredAt
      )
    `, { expiredAt });
    this.database.prepare(`
      DELETE FROM transcript_native_records
      WHERE turn_id IN (SELECT turn_id FROM thread_turn_payload_retention WHERE expired_at = ?)
    `).run(expiredAt);
    this.database.prepare(`
      DELETE FROM thread_items
      WHERE turn_id IN (SELECT turn_id FROM thread_turn_payload_retention WHERE expired_at = ?)
    `).run(expiredAt);
    return inserted;
  }
}
