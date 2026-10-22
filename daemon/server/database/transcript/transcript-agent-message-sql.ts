/*
 * Exports:
 * - registerTranscriptAgentMessageFunction: install `wb_transcript_agent_message(text)` on a connection.
 * - agentMessageInputSql: whether a user-message item carries a cross-agent message envelope.
 * - agentMessageOutputSql: whether a function-output item is a native Workbench agent message.
 */
import type Database from "better-sqlite3";
import { readWorkbenchAgentMessageText } from "workbench-shared/workbench/thread/thread-agent-message";

export function registerTranscriptAgentMessageFunction(database: Database.Database) {
  database.function("wb_transcript_agent_message", { deterministic: true }, (value: string) => readWorkbenchAgentMessageText(value) ? 1 : 0);
}

/** Requires `registerTranscriptAgentMessageFunction` on the connection. */
export function agentMessageInputSql(item: string) {
  return `EXISTS (SELECT 1 FROM thread_user_message_parts mp
    WHERE mp.item_id = ${item}.id AND mp.part_type = 'text' AND wb_transcript_agent_message(mp.text))`;
}

export function agentMessageOutputSql(item: string) {
  return `EXISTS (SELECT 1 FROM thread_item_tool_outputs o
    WHERE o.item_id = ${item}.id AND o.namespace = 'workbench' AND o.name = 'agent_message')`;
}
