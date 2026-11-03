/*
 * Exports:
 * - RejectedToolCallKind: why a failed call never ran: a workflow mode or lock refused it, or the provider had no such tool.
 * - getRejectedToolCallKind: classify one failed tool call, or null for anything else.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { isWorkflowDenialText } from "workbench-shared/workbench/thread/workflow-denials";

export type RejectedToolCallKind = "modeDenial" | "unknownTool";

/** Claude Code's unknown-tool result, and the Workbench OpenCode plugin's refusal of native tools outside the managed set. */
const UNKNOWN_TOOL_PATTERNS = [/No such tool available: /u, /^Native OpenCode tool \S+ is unavailable in a managed Workbench session\./mu];

function textOf(value: unknown) {
  return value !== null && typeof value === "object" && "text" in value && typeof value.text === "string" ? value.text : null;
}

function failureText(item: ThreadItem) {
  if (item.type === "mcpToolCall" && item.status === "failed") {
    return [item.error?.message ?? null, ...(item.result?.content ?? []).map(textOf)];
  }
  if (item.type === "dynamicToolCall" && (item.status === "failed" || item.success === false)) {
    return (item.contentItems ?? []).map(textOf);
  }
  return [];
}

export function getRejectedToolCallKind(item: ThreadItem): RejectedToolCallKind | null {
  const text = failureText(item).filter(part => part !== null).join("\n");
  if (!text) return null;
  if (UNKNOWN_TOOL_PATTERNS.some(pattern => pattern.test(text))) return "unknownTool";
  return isWorkflowDenialText(text) ? "modeDenial" : null;
}
