/*
 * Exports:
 * - NativeFileChange: one file row derived from a provider-native file tool call.
 * - isNativeFileOperation: identify native file calls rendered as file changes, by provider namespace.
 * - getNativeFileChanges: derive file targets and evidence from a native file call.
 */
import type { ThreadItem, FileUpdateChange } from "workbench-shared/workbench/thread/workbench-thread-items";
import type { WorkbenchFileChangeFailureKind } from "workbench-shared/workbench/thread/workbench-file-change";
import { getClaudeFileChanges, isClaudeFileOperation } from "./claude";
import { getOpenCodeFileChanges, isOpenCodeFileOperation } from "./opencode";

type NativeItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

export interface NativeFileChange {
  change: FileUpdateChange;
  sourceItemId: string;
  sourceChangeIndex: number;
  danger: boolean;
  failureKind?: WorkbenchFileChangeFailureKind;
  summaryTotals?: { additions: number; deletions: number };
  presentationLabel?: string;
}

const providers: Array<{ is(item: ThreadItem): boolean; changes(item: NativeItem): NativeFileChange[] }> = [
  { is: isOpenCodeFileOperation, changes: getOpenCodeFileChanges },
  { is: isClaudeFileOperation, changes: getClaudeFileChanges },
];

// The namespace intersection keeps other dynamic tool calls in the guard's false branch.
export function isNativeFileOperation(item: ThreadItem): item is NativeItem & { namespace: "opencode" | "claude" } {
  return item.type === "dynamicToolCall" && providers.some(provider => provider.is(item));
}

export function getNativeFileChanges(item: NativeItem): NativeFileChange[] {
  return providers.find(provider => provider.is(item))?.changes(item) ?? [];
}
