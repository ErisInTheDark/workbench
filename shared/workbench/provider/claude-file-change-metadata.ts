/*
 * Exports:
 * - ClaudeFileChangeMetadata: Workbench-owned evidence recorded on native Claude Edit/Write tool items.
 * - readClaudeFileChangeMetadata: defensively read that evidence from stored item metadata.
 */
import type { JsonValue } from "../thread/workbench-thread-items.ts";

export interface ClaudeFileChangeMetadata {
  /** Effective change Claude applied, as unified hunks or whole-file content for a created file. */
  fileChange?: { kind: "add" | "update"; diff: string };
  /** Set when Workbench denied the call because no active claim covered its path. */
  workbenchFailureKind?: "unclaimed";
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function readClaudeFileChangeMetadata(value: JsonValue | undefined): ClaudeFileChangeMetadata {
  const metadata = record(value);
  const change = record(metadata?.fileChange);
  return {
    ...(change && (change.kind === "add" || change.kind === "update") && typeof change.diff === "string"
      ? { fileChange: { kind: change.kind, diff: change.diff } } : {}),
    ...(metadata?.workbenchFailureKind === "unclaimed" ? { workbenchFailureKind: "unclaimed" as const } : {}),
  };
}
