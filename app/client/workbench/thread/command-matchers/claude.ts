/*
 * Exports:
 * - getClaudeToolDisplay: summarise native Claude Code Read, Grep, and Glob calls from their structured arguments.
 * - isClaudeFileOperation: identify native Claude Edit and Write calls.
 * - getClaudeFileChanges: present Edit as an edit and Write as a create, with the effective diff once Claude applied it.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { readClaudeFileChangeMetadata } from "workbench-shared/workbench/provider/claude-file-change-metadata";
import { nativePathToolSummary } from "./native-tools";
import type { NativeFileChange } from "./native-file-changes";
import type { ThreadCommandSummaryDisplay } from "./types";

type NativeItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;
const record = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

export function getClaudeToolDisplay(item: NativeItem): ThreadCommandSummaryDisplay | null {
  if (item.namespace !== "claude") return null;
  const args = record(item.arguments);
  if (!args) return null;
  if (item.tool === "Read") {
    const path = text(args.file_path);
    return path ? nativePathToolSummary({ claimedBy: "claude.read", kind: "read", path }) : null;
  }
  if (item.tool === "Grep" || item.tool === "Glob") {
    const pattern = text(args.pattern);
    if (!pattern) return null;
    return nativePathToolSummary({
      claimedBy: item.tool === "Grep" ? "claude.grep" : "claude.glob",
      kind: item.tool === "Grep" ? "search" : "list",
      path: text(args.path),
      pattern: { text: pattern, syntax: item.tool === "Grep" ? "regex" : "literal" },
    });
  }
  return null;
}

export function isClaudeFileOperation(item: ThreadItem): item is NativeItem & { namespace: "claude"; tool: "Edit" | "Write" } {
  return item.type === "dynamicToolCall" && item.namespace === "claude" && (item.tool === "Edit" || item.tool === "Write");
}

export function getClaudeFileChanges(item: NativeItem): NativeFileChange[] {
  if (!isClaudeFileOperation(item)) return [];
  const path = text(record(item.arguments)?.file_path);
  if (!path) return [];
  const failed = item.status === "failed" || item.success === false;
  const metadata = readClaudeFileChangeMetadata(item.metadata);
  // Only a completed result carries what Claude applied; until then the tool decides the intent.
  const applied = !failed && item.status === "completed" ? metadata.fileChange : undefined;
  const kind = applied?.kind ?? (item.tool === "Write" ? "add" : "update");
  return [{
    change: { path, kind: kind === "add" ? { type: "add" } : { type: "update", move_path: null }, diff: applied?.diff ?? "" },
    sourceItemId: item.id, sourceChangeIndex: 0, danger: failed,
    ...(failed && metadata.workbenchFailureKind ? { failureKind: metadata.workbenchFailureKind } : {}),
  }];
}
