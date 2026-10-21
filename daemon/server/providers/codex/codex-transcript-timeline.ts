/*
 * Exports:
 * - createDynamicToolCallItem: build a provider dynamic-tool item from its server request.
 */
import type { DynamicToolCallParams } from "workbench-shared/codex/generated/app-server/v2/DynamicToolCallParams";
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";

export function createDynamicToolCallItem(params: DynamicToolCallParams): Extract<ThreadItem, { type: "dynamicToolCall" }> {
  return {
    arguments: params.arguments,
    contentItems: null,
    durationMs: null,
    id: params.callId,
    namespace: params.namespace ?? null,
    status: "inProgress",
    success: null,
    tool: params.tool,
    type: "dynamicToolCall",
  };
}
