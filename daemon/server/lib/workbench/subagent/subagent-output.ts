/*
 * Exports:
 * - createEmptySubagentQuestionnaireResponse: resolve every pending question without a selection.
 * - renderSubagentQuestionnaireOutput/renderSubagentTurnOutput: render paused and settled WB turns.
 * - renderSubagentWaitResultOutput: identify which child triggered a multiplexed wait while preserving singular output.
 * - renderSubagentListOutput/renderSubagentSettleOutput: render relationship lists and settlement receipts.
 */
import type { Turn } from "workbench-shared/workbench/thread/workbench-thread-turn";
import type { WorkbenchSubagentSummary, WorkbenchUserInputRequest, WorkbenchUserInputResponse } from "workbench-shared/types";

export function createEmptySubagentQuestionnaireResponse(request: WorkbenchUserInputRequest): WorkbenchUserInputResponse {
  return { answers: Object.fromEntries(request.questions.map((question) => [question.id, { answers: [] }])) };
}

function trailingCommentary(thread: { turns: Turn[] }) {
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

export function renderSubagentQuestionnaireOutput(thread: { turns: Turn[] }, request: WorkbenchUserInputRequest) {
  return [trailingCommentary(thread), renderQuestion(request)].filter(Boolean).join("\n\n");
}

export function renderSubagentTurnOutput(thread: { turns: Turn[] }) {
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

export function renderSubagentListOutput(subagents: readonly WorkbenchSubagentSummary[], settled: boolean, nextCursor: string | null) {
  if (!subagents.length) return settled ? "No settled subagents." : "No unsettled subagents.";
  const rows = subagents.map((subagent) => {
    const status = subagent.lifecycle?.kind ?? (subagent.activityStatus === "active" ? "working" : "completed");
    const control = subagent.pinned ? "Locked" : "Parent-controlled";
    return [
      `Name: ${subagent.name}`,
      `Status: ${status}`,
      `Title: ${subagent.title}`,
      `Last activity: ${new Date(subagent.lastActivityAt).toLocaleString()}`,
      ...(settled ? [`Thread ID: ${subagent.threadId}`, "Resume: use --id"] : [`Control: ${control}`]),
    ].join("\n");
  });
  const hints = [] as string[];
  if (!settled && subagents.some((subagent) => subagent.pinned)) hints.push("locked: this subagent is user-owned and may send you follow-up messages");
  if (settled) hints.push("in order to resume a settled thread, use `--id <id>` instead of `--name <name>`");
  if (settled && nextCursor) hints.push(`Next cursor: ${nextCursor}`);
  return [...rows, ...hints].join("\n\n");
}

export function renderSubagentSettleOutput(settled: readonly { name: string; threadId: string }[]) {
  return settled.length ? settled.map((entry) => `Settled ${entry.name} (${entry.threadId}).`).join("\n") : "No subagents were settled.";
}
