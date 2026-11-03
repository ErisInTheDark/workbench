/*
 * Exports:
 * - default WorkbenchWorkflowLedgerRepository: read what a thread's recent settled Workbench workflow calls, messages to its parent,
 *   own-history recalls, completed compactions and user-visible agent messages contributed, in transcript order, anchored by its
 *   latest mode entry.
 */
import type Database from "better-sqlite3";
import { WORKBENCH_TURN_END_MARKER } from "workbench-shared/workbench/thread/thread-recovery-message";
import {
  currentWorkflowMode, readWorkflowLedgerEntries, THREAD_STATE_TOOL, type WorkflowLedgerEntry,
} from "workbench-shared/workbench/thread/workflow-modes";
import { WORKBENCH_TOOL_SERVERS } from "../stats/WorkbenchToolStatsRepository.ts";

/** Enough for many loops of every checklist and their messages; a longer thread only narrows the window, so gates ask for fresh proofs. */
const LEDGER_ROW_LIMIT = 1000;
const LEGACY_MODE_TOOL = "mode_set";
/**
 * `proof_of_work` and `mode_set` keep gate windows and modes of threads that filed before thread_state; `message_agent` opens
 * parent-message gates; `thread_recall` settles compaction recovery.
 */
const LEDGER_TOOLS = [THREAD_STATE_TOOL, "proof_of_work", LEGACY_MODE_TOOL, "message_agent", "thread_recall"];
const MODE_TOOLS = [THREAD_STATE_TOOL, LEGACY_MODE_TOOL];

type CallRow = { kind: "call"; tool_name: string; arguments_json: string; failed: number };
type LedgerRow =
  | CallRow
  | { kind: "message" | "compaction"; tool_name: null; arguments_json: null; failed: null };

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
        UNION ALL
        SELECT 'compaction', NULL, NULL, NULL, tr.turn_index, i.item_position
        FROM thread_items i
        JOIN thread_turns tr ON tr.id = i.turn_id
        JOIN thread_item_context_compactions k ON k.item_id = i.id
        WHERE i.thread_id = ? AND k.state = 'completed'
      )
      ORDER BY turn_index DESC, item_position DESC
      LIMIT ?
    `).all(
      threadId, ...WORKBENCH_TOOL_SERVERS, ...LEDGER_TOOLS, threadId, WORKBENCH_TURN_END_MARKER, threadId, LEDGER_ROW_LIMIT,
    ) as LedgerRow[];
    const entries = rows.reverse().flatMap((row): WorkflowLedgerEntry[] => row.kind === "call"
      ? this.#entries(threadId, row)
      : [row.kind === "message" ? { kind: "message", audience: "user" } : { kind: "compaction" }]);
    return currentWorkflowMode(entries) === null ? [...this.#latestMode(threadId), ...entries] : entries;
  }

  #entries(threadId: string, row: CallRow) {
    return readWorkflowLedgerEntries({ threadId, tool: row.tool_name, args: JSON.parse(row.arguments_json), failed: row.failed !== 0 });
  }

  /** A mode entered before the window still governs the thread; only its mode entry is kept, so no proof window reopens. */
  #latestMode(threadId: string): WorkflowLedgerEntry[] {
    const servers = WORKBENCH_TOOL_SERVERS.map(() => "?").join(", ");
    const tools = MODE_TOOLS.map(() => "?").join(", ");
    const row = this.database.prepare(`
      SELECT 'call' AS kind, c.tool_name, c.arguments_json, 0 AS failed
      FROM thread_items i
      JOIN thread_turns tr ON tr.id = i.turn_id
      JOIN thread_operation_callable_tool_sources c ON c.item_id = i.id
      WHERE i.thread_id = ? AND c.callable_kind = 'mcp' AND c.server_name IN (${servers}) AND c.tool_name IN (${tools})
        AND c.state = 'completed' AND c.error_text IS NULL AND json_extract(c.arguments_json, '$.mode') IS NOT NULL
      ORDER BY tr.turn_index DESC, i.item_position DESC
      LIMIT 1
    `).get(threadId, ...WORKBENCH_TOOL_SERVERS, ...MODE_TOOLS) as CallRow | undefined;
    return row ? this.#entries(threadId, row).filter(entry => entry.kind === "mode") : [];
  }
}
