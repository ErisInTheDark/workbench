/*
 * Exports:
 * - createEmptySubagentQuestionnaireResponse: resolve every pending question without a selection. Keywords: subagent, questionnaire, empty response.
 * - renderSubagentQuestionnaireOutput/renderSubagentTurnOutput: produce native wait stdout for paused and settled subagent turns. Keywords: subagent, wait, commentary, final.
 * - renderSubagentWaitResultOutput: identify which child triggered a multiplexed wait while preserving singular output. Keywords: subagent, multiplex, wait, output.
 */
import type { Thread } from "../../codex/generated/app-server/v2/Thread";
import type { WorkbenchUserInputRequest, WorkbenchUserInputResponse } from "../../types";

export function createEmptySubagentQuestionnaireResponse(request: WorkbenchUserInputRequest): WorkbenchUserInputResponse {
  return { answers: Object.fromEntries(request.questions.map((question) => [question.id, { answers: [] }])) };
}

function trailingCommentary(thread: Thread) {
  const items = thread.turns.at(-1)?.items ?? [];
  const messages: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.type === "userMessage") break;
    if (item.type === "agentMessage" && item.phase === "commentary" && item.text.trim()) messages.unshift(item.text.trim());
  }
  return messages.join("\n\n");
}

function renderQuestion(request: WorkbenchUserInputRequest) {
  return request.questions.map((question) => {
    const lines = [question.header.trim(), question.question.trim()].filter(Boolean);
    lines.push(...question.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`));
    return lines.join("\n");
  }).join("\n\n");
}

export function renderSubagentQuestionnaireOutput(thread: Thread, request: WorkbenchUserInputRequest) {
  return [trailingCommentary(thread), renderQuestion(request)].filter(Boolean).join("\n\n");
}

export function renderSubagentTurnOutput(thread: Thread) {
  const messages = (thread.turns.at(-1)?.items ?? []).filter((item): item is Extract<typeof item, { type: "agentMessage" }> => (
    item.type === "agentMessage" && Boolean(item.text.trim())
  ));
  const finalMessage = messages.slice().reverse().find((item) => item.phase === "final_answer");
  return (finalMessage ?? messages.at(-1))?.text.trim() ?? "";
}

export function renderSubagentWaitResultOutput({
  multiplexed,
  name,
  outcome,
  output,
  threadId,
}: {
  multiplexed: boolean;
  name: string;
  outcome: "finished" | "needs-interaction";
  output: string;
  threadId: string;
}) {
  if (!multiplexed) return output;
  const status = outcome === "needs-interaction" ? "needs interaction" : "finished its current turn";
  return [`Subagent ${name} (${threadId}) ${status}.`, output].filter(Boolean).join("\n\n");
}
