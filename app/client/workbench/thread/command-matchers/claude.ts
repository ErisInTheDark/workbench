/*
 * Exports:
 * - getClaudeToolDisplay: summarise native Claude Code Read, Grep, and Glob calls from their structured arguments.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
import { nativePathToolSummary } from "./native-tools";
import type { ThreadCommandSummaryDisplay } from "./types";

type NativeItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

const text = (value: unknown) => typeof value === "string" && value.trim() ? value : null;

export function getClaudeToolDisplay(item: NativeItem): ThreadCommandSummaryDisplay | null {
  if (item.namespace !== "claude") return null;
  const args = item.arguments !== null && typeof item.arguments === "object" && !Array.isArray(item.arguments)
    ? item.arguments as Record<string, unknown> : null;
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
