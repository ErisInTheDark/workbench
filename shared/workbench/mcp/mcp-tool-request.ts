/*
 * Exports:
 * - MCP_TOOL_REQUEST_QUESTION_ID/MCP_TOOL_REQUEST_APPROVE/MCP_TOOL_REQUEST_DENY: the fixed decision an MCP tool enable request carries.
 * - mcpToolRequestQuestions: the questionnaire questions an enable request is stored as.
 * - isMcpToolRequestApproved: whether a response approves the request; anything else denies it.
 */
import type { WorkbenchUserInputResponse } from "../../types.ts";

export const MCP_TOOL_REQUEST_QUESTION_ID = "decision";
export const MCP_TOOL_REQUEST_APPROVE = "Approve";
export const MCP_TOOL_REQUEST_DENY = "Deny";

export function mcpToolRequestQuestions(reason: string) {
  return [{
    id: MCP_TOOL_REQUEST_QUESTION_ID, header: "MCP tool", question: reason,
    options: [
      { label: MCP_TOOL_REQUEST_APPROVE, description: "Let agents call this tool." },
      { label: MCP_TOOL_REQUEST_DENY, description: "Keep this tool disabled." },
    ],
  }];
}

export function isMcpToolRequestApproved(response: WorkbenchUserInputResponse | null | undefined) {
  const answers = response?.answers[MCP_TOOL_REQUEST_QUESTION_ID]?.answers ?? [];
  return answers.length === 1 && answers[0] === MCP_TOOL_REQUEST_APPROVE;
}
