/*
 * Exports:
 * - transcriptQueryFields: canonical field registry shared by matching and expansion.
 * - transcriptQueryKindSql: map stored item discriminators to CLI kinds.
 * - transcriptQueryFieldsSql: join registered fields to a bounded candidate CTE.
 */

interface QueryFieldSource {
  name: string;
  table: string;
  columns: readonly string[];
  index?: string;
  join?: string;
  where?: string;
  opaque?: boolean;
}

export const transcriptQueryFields: readonly QueryFieldSource[] = [
  { name: "user", table: "thread_user_message_parts", columns: ["text", "path", "name"], index: "part_index" },
  { name: "user", table: "thread_item_user_messages", columns: ["error_text"] },
  { name: "assistant", table: "thread_item_assistant_messages", columns: ["text"] },
  { name: "reasoning", table: "thread_reasoning_sections", columns: ["text"], index: "section_index" },
  { name: "process", table: "thread_operation_process_sources", columns: ["command", "cwd", "output_text", "error_text"] },
  { name: "tool", table: "thread_operation_tool_sources", columns: ["tool_name"] },
  { name: "call", table: "thread_operation_callable_tool_sources", columns: ["arguments_json", "namespace", "server_name", "error_text"] },
  { name: "result", table: "thread_callable_dynamic_content", columns: ["text"], index: "content_index" },
  { name: "mcp", table: "thread_callable_mcp_result_content", columns: ["text"], index: "content_index" },
  { name: "mcp", table: "thread_callable_mcp_results", columns: ["structured_content_json"] },
  { name: "mcp-opaque", table: "thread_callable_mcp_result_content", columns: ["opaque_json"], index: "content_index", opaque: true },
  { name: "mcp-meta", table: "thread_callable_mcp_results", columns: ["meta_json"], opaque: true },
  { name: "output", table: "thread_item_tool_outputs", columns: ["name", "namespace", "body_text"] },
  { name: "output-part", table: "thread_tool_output_parts", columns: ["text"], index: "part_index" },
  { name: "collaboration", table: "thread_operation_collaboration_tool_sources", columns: ["prompt", "sender_thread_id"] },
  { name: "receiver", table: "thread_collaboration_receivers", columns: ["receiver_thread_id"], index: "receiver_index" },
  { name: "agent", table: "thread_collaboration_agent_states", columns: ["agent_thread_id", "status", "message"], index: "f.agent_thread_id" },
  { name: "file", table: "thread_file_changes", columns: ["path", "move_path", "diff"], index: "change_index" },
  { name: "file-state", table: "thread_item_file_changes", columns: ["error_text", "recovery_detail"] },
  { name: "web", table: "thread_item_web_searches", columns: ["query", "action_query", "url", "pattern", "error_text"] },
  { name: "web-query", table: "thread_web_search_queries", columns: ["query"], index: "query_index" },
  { name: "web-result", table: "thread_web_search_results", columns: ["opaque_json"], index: "result_index", opaque: true },
  { name: "interaction", table: "thread_item_interactions", columns: ["title", "summary", "error_text"] },
  { name: "question", table: "thread_interaction_questions", columns: ["header", "question"], index: "question_index" },
  { name: "option", table: "thread_interaction_options", columns: ["label", "description"], index: "printf('%08d.%08d', f.question_index, f.option_index)" },
  { name: "answer", table: "thread_interaction_answers", columns: ["CASE WHEN q.is_secret = 1 THEN '[redacted]' ELSE f.answer END"],
    index: "f.question_id || '.' || printf('%08d', f.answer_index)",
    join: "JOIN thread_interaction_questions q ON q.item_id = f.item_id AND q.question_id = f.question_id" },
  { name: "approval", table: "thread_approval_command_contexts", columns: ["command", "cwd"] },
  { name: "compaction", table: "thread_item_context_compactions", columns: ["state", "error_text"] },
  { name: "unknown", table: "thread_item_unknown", columns: ["native_type", "safe_json"], opaque: true },
];

export const transcriptQueryKindSql = `CASE i.type
  WHEN 'userMessage' THEN CASE WHEN u.input_kind = 'steer' THEN 'user-steer' ELSE 'user-message' END
  WHEN 'assistantMessage' THEN 'assistant-message'
  WHEN 'operation' THEN CASE WHEN p.item_id IS NOT NULL THEN 'process' WHEN t.tool_kind = 'collaboration' THEN 'collaboration' ELSE 'tool' END
  WHEN 'functionCallOutput' THEN 'tool-output'
  WHEN 'fileChange' THEN 'file-change'
  WHEN 'webSearch' THEN 'web-search'
  WHEN 'contextCompaction' THEN 'compaction'
  ELSE i.type END`;

export function transcriptQueryFieldsSql(opaque: boolean) {
  return transcriptQueryFields.filter(source => opaque || !source.opaque).flatMap(source => source.columns.map(column => {
    const expression = column.startsWith("CASE ") ? column : `f.${column}`;
    const label = column.startsWith("CASE ") ? "text" : column;
    const index = source.index ? (/^\w+$/u.test(source.index) ? `printf('%08d', f.${source.index})` : source.index) : "''";
    return `SELECT c.id AS item_id, '${source.name}.${label}.' || ${index} AS name, ${expression} AS text
      FROM candidate c JOIN ${source.table} f ON f.item_id = c.id ${source.join ?? ""}
      WHERE ${expression} IS NOT NULL AND ${expression} <> '' ${source.where ? `AND ${source.where}` : ""}`;
  })).join("\nUNION ALL\n");
}
