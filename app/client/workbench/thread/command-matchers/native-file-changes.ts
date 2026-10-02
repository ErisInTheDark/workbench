/*
 * Exports:
 * - NativeFileChange: one file row derived from a provider-native or wb tool file call.
 * - NativeFileOperationItem: tool-call item shapes that can carry file operations.
 * - isNativeFileOperation: identify tool calls rendered as file changes, by provider namespace or wb tool.
 * - getNativeFileChanges: derive file targets and evidence from a file tool call.
 * - getNativeFileOperationOutcome: normalise a file tool call's lifecycle across item shapes.
 */
import type { ThreadItem, FileUpdateChange } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchFileChangeFailureKind } from "workbench-shared/workbench/thread/workbench-file-change";
import { getClaudeFileChanges, isClaudeFileOperation } from "./claude";
import { getOpenCodeFileChanges, isOpenCodeFileOperation } from "./opencode";
import { getWorkbenchFileRemovalChanges, isWorkbenchFileRemoval } from "./workbench-mcp";

export type NativeFileOperationItem = Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>;

export interface NativeFileChange {
  change: FileUpdateChange;
  sourceItemId: string;
  sourceChangeIndex: number;
  danger: boolean;
  failureKind?: WorkbenchFileChangeFailureKind;
  summaryTotals?: { additions: number; deletions: number };
  presentationLabel?: string;
}

const providers: Array<{ is(item: ThreadItem): boolean; changes(item: NativeFileOperationItem): NativeFileChange[] }> = [
  { is: isOpenCodeFileOperation, changes: getOpenCodeFileChanges },
  { is: isClaudeFileOperation, changes: getClaudeFileChanges },
  { is: isWorkbenchFileRemoval, changes: getWorkbenchFileRemovalChanges },
];

// Narrow intersections keep other dynamic and MCP calls in the guard's false branch.
type RecognisedFileOperationItem =
  | (Extract<ThreadItem, { type: "dynamicToolCall" }> & { namespace: "opencode" | "claude" })
  | (Extract<ThreadItem, { type: "mcpToolCall" }> & { tool: "rm" });

export function isNativeFileOperation(item: ThreadItem): item is RecognisedFileOperationItem {
  return (item.type === "dynamicToolCall" || item.type === "mcpToolCall") && providers.some(provider => provider.is(item));
}

export function getNativeFileChanges(item: NativeFileOperationItem): NativeFileChange[] {
  return providers.find(provider => provider.is(item))?.changes(item) ?? [];
}

export function getNativeFileOperationOutcome(item: NativeFileOperationItem): "inProgress" | "completed" | "failed" {
  if (item.status === "failed" || (item.type === "dynamicToolCall" && item.success === false)) return "failed";
  return item.status === "inProgress" ? "inProgress" : "completed";
}
