/*
 * Exports:
 * - default WorkbenchWorkflowLedgerRepository: read what a thread's recent settled Workbench workflow calls and user-visible agent
 *   messages contributed, in transcript order.
 */
import type Database from "better-sqlite3";
import { WORKBENCH_TURN_END_MARKER } from "workbench-shared/workbench/thread/thread-recovery-message";
import { readWorkflowLedgerEntries, THREAD_STATE_TOOL, type WorkflowLedgerEntry } from "workbench-shared/workbench/thread/workflow-modes";
import { WORKBENCH_TOOL_SERVERS } from "../stats/WorkbenchToolStatsRepository.ts";

/** Enough for many loops of every checklist and their messages; a longer thread only narrows the window, so gates ask for fresh proofs. */
const LEDGER_ROW_LIMIT = 1000;
/** Legacy names keep gate windows and modes of threads that filed before thread_state. */
const LEDGER_TOOLS = [THREAD_STATE_TOOL, "proof_of_work", "mode_set"];

type LedgerRow =
  | { kind: "call"; tool_name: string; arguments_json: string; failed: number }
  | { kind: "message"; tool_name: null; arguments_json: null; failed: null };

export default class WorkbenchWorkflowLedgerRepository {
  constructor(private readonly database: Database.Database) {}

  read(threadId: string): WorkflowLedgerEntry[] {
    const servers = WORKBENCH_TOOL_SERVERS.map(() => "?").join(", ");
    const tools = LEDGER_TOOLS.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT kind, tool_name, arguments_json, failed FROM (
        SELECT 'call' AS kind, c.tool_name, c.arguments_json, (c.state <> 'completed' OR c.error_text IS NOT NULL) AS failed,
          tr.turn_index, i.item_position
        FROM thread_items i
        JOIN thread_turns tr ON tr.id = i.turn_id
        JOIN thread_operation_callable_tool_sources c ON c.item_id = i.id
        WHERE i.thread_id = ? AND c.callable_kind = 'mcp' AND c.server_name IN (${servers}) AND c.tool_name IN (${tools})
          AND c.state IN ('completed', 'failed')
        UNION ALL
        SELECT 'message', NULL, NULL, NULL, tr.turn_index, i.item_position
        FROM thread_items i
        JOIN thread_turns tr ON tr.id = i.turn_id
        JOIN thread_item_assistant_messages a ON a.item_id = i.id
        WHERE i.thread_id = ? AND trim(a.text, ' ' || char(9, 10, 13)) NOT IN ('', ?)
      )
      ORDER BY turn_index DESC, item_position DESC
      LIMIT ?
    `).all(threadId, ...WORKBENCH_TOOL_SERVERS, ...LEDGER_TOOLS, threadId, WORKBENCH_TURN_END_MARKER, LEDGER_ROW_LIMIT) as LedgerRow[];
    return rows.reverse().flatMap(row => row.kind === "message" ? [{ kind: "message" } as const] : readWorkflowLedgerEntries({
      tool: row.tool_name, args: JSON.parse(row.arguments_json), failed: row.failed !== 0,
    }));
  }
}
