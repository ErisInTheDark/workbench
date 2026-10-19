/*
 * Exports:
 * - MCP_TOOL_REQUEST_QUESTION_ID/MCP_TOOL_REQUEST_APPROVE/MCP_TOOL_REQUEST_DENY: the fixed decision an MCP tool enable request carries.
 * - mcpToolRequestQuestions: the questionnaire questions an enable or sign-in request is stored as.
 * - isMcpToolRequestApproved: whether a response approves the request; anything else denies it.
 */
import type { WorkbenchUserInputResponse } from "../../types.ts";

export const MCP_TOOL_REQUEST_QUESTION_ID = "decision";
export const MCP_TOOL_REQUEST_APPROVE = "Approve";
export const MCP_TOOL_REQUEST_DENY = "Deny";

const DECISIONS = {
  enable: { header: "MCP tool", approve: "Let agents call this tool.", deny: "Keep this tool disabled." },
  authorize: { header: "MCP sign-in", approve: "I finished; the agent retries.", deny: "I did not sign in." },
} as const;

export function mcpToolRequestQuestions(reason: string, kind: keyof typeof DECISIONS = "enable") {
  const decision = DECISIONS[kind];
  return [{
    id: MCP_TOOL_REQUEST_QUESTION_ID, header: decision.header, question: reason,
    options: [
      { label: MCP_TOOL_REQUEST_APPROVE, description: decision.approve },
      { label: MCP_TOOL_REQUEST_DENY, description: decision.deny },
    ],
  }];
}

export function isMcpToolRequestApproved(response: WorkbenchUserInputResponse | null | undefined) {
  const answers = response?.answers[MCP_TOOL_REQUEST_QUESTION_ID]?.answers ?? [];
  return answers.length === 1 && answers[0] === MCP_TOOL_REQUEST_APPROVE;
}
