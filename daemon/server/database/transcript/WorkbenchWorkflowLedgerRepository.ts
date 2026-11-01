/*
 * Exports:
 * - default WorkbenchWorkflowLedgerRepository: read a thread's recent successful proof filings and mode switches in transcript order.
 */
import type Database from "better-sqlite3";
import { MODE_SWITCH_TOOL, readWorkflowLedgerEntry, type WorkflowLedgerEntry } from "workbench-shared/workbench/thread/workflow-modes";
import { WORKBENCH_TOOL_SERVERS } from "../stats/WorkbenchToolStatsRepository.ts";

/** Enough for many loops of every checklist; a longer thread only narrows the window, so gates ask for fresh proofs. */
const LEDGER_ENTRY_LIMIT = 500;
const LEDGER_TOOLS = ["proof_of_work", MODE_SWITCH_TOOL];

type LedgerRow = { tool_name: string; arguments_json: string };

export default class WorkbenchWorkflowLedgerRepository {
  constructor(private readonly database: Database.Database) {}

  read(threadId: string): WorkflowLedgerEntry[] {
    const servers = WORKBENCH_TOOL_SERVERS.map(() => "?").join(", ");
    const tools = LEDGER_TOOLS.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT c.tool_name, c.arguments_json
      FROM thread_items i
      JOIN thread_turns tr ON tr.id = i.turn_id
      JOIN thread_operation_callable_tool_sources c ON c.item_id = i.id
      WHERE i.thread_id = ? AND c.callable_kind = 'mcp' AND c.server_name IN (${servers}) AND c.tool_name IN (${tools})
        AND c.state = 'completed' AND c.error_text IS NULL
      ORDER BY tr.turn_index DESC, i.item_position DESC
      LIMIT ?
    `).all(threadId, ...WORKBENCH_TOOL_SERVERS, ...LEDGER_TOOLS, LEDGER_ENTRY_LIMIT) as LedgerRow[];
    return rows.reverse().flatMap((row) => {
      const entry = readWorkflowLedgerEntry(row.tool_name, JSON.parse(row.arguments_json));
      return entry ? [entry] : [];
    });
  }
}
