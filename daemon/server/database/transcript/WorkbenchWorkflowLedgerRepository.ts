/*
 * Exports:
 * - default WorkbenchWorkflowLedgerRepository: read what a thread's recent settled Workbench workflow calls contributed, in transcript order.
 */
import type Database from "better-sqlite3";
import { readWorkflowLedgerEntries, THREAD_STATE_TOOL, type WorkflowLedgerEntry } from "workbench-shared/workbench/thread/workflow-modes";
import { WORKBENCH_TOOL_SERVERS } from "../stats/WorkbenchToolStatsRepository.ts";

/** Enough for many loops of every checklist; a longer thread only narrows the window, so gates ask for fresh proofs. */
const LEDGER_CALL_LIMIT = 500;
/** Legacy names keep gate windows and modes of threads that filed before thread_state. */
const LEDGER_TOOLS = [THREAD_STATE_TOOL, "proof_of_work", "mode_set"];

type LedgerRow = { tool_name: string; arguments_json: string; failed: number };

export default class WorkbenchWorkflowLedgerRepository {
  constructor(private readonly database: Database.Database) {}

  read(threadId: string): WorkflowLedgerEntry[] {
    const servers = WORKBENCH_TOOL_SERVERS.map(() => "?").join(", ");
    const tools = LEDGER_TOOLS.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT c.tool_name, c.arguments_json, (c.state <> 'completed' OR c.error_text IS NOT NULL) AS failed
      FROM thread_items i
      JOIN thread_turns tr ON tr.id = i.turn_id
      JOIN thread_operation_callable_tool_sources c ON c.item_id = i.id
      WHERE i.thread_id = ? AND c.callable_kind = 'mcp' AND c.server_name IN (${servers}) AND c.tool_name IN (${tools})
        AND c.state IN ('completed', 'failed')
      ORDER BY tr.turn_index DESC, i.item_position DESC
      LIMIT ?
    `).all(threadId, ...WORKBENCH_TOOL_SERVERS, ...LEDGER_TOOLS, LEDGER_CALL_LIMIT) as LedgerRow[];
    return rows.reverse().flatMap(row => readWorkflowLedgerEntries({
      tool: row.tool_name, args: JSON.parse(row.arguments_json), failed: row.failed !== 0,
    }));
  }
}
