/*
 * Exports:
 * - getOpenCodeToolDisplay: summarise native arguments and recorded discovery calls without parsing code.
 * - getOpenCodeFileChanges: present validated final provider file evidence, including failure.
 */
import type { ThreadItem, FileUpdateChange } from "workbench-shared/workbench/thread/workbench-thread-items";
import { createEmptyCommandSummaryStats, summarizeDisplayParts } from "./helpers";
import type { ThreadCommandDisplayPart, ThreadCommandSummaryDisplay, ThreadCommandDetailRow } from "./types";

type NativeItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const pathTools: Record<string, { done: string; ongoing: string; stat?: "readFiles" | "searchedFiles" | "listedFiles" }> = {
  read: { done: "Read", ongoing: "Reading", stat: "readFiles" },
  grep: { done: "Searched", ongoing: "Searching", stat: "searchedFiles" },
  glob: { done: "Listed", ongoing: "Listing", stat: "listedFiles" },
  edit: { done: "Edited", ongoing: "Editing" },
  write: { done: "Wrote", ongoing: "Writing" },
};

function summary(tool: string, args: Record<string, unknown>): ThreadCommandSummaryDisplay | null {
  if (tool === "patch") {
    if (typeof args.patchText !== "string" || !args.patchText.startsWith("*** Begin Patch")) return null;
    const paths = args.patchText.split(/\r?\n/).flatMap(line => {
      const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
      return header ? [header[1]!] : [];
    });
    if (!paths.length) return null;
    const targets = paths.flatMap((path, index): ThreadCommandDisplayPart[] =>
      [...(index ? [{ type: "text" as const, text: ", " }] : []), { type: "path", path }]);
    const summaryParts: ThreadCommandDisplayPart[] = [{ type: "text", text: "Patched " }, ...targets];
    const ongoingSummaryParts: ThreadCommandDisplayPart[] = [{ type: "text", text: "Patching " }, ...targets];
    return { claimedBy: "opencode.patch", omitFromDisplay: false, shell: null, showShell: false,
      summaryKind: "matched", summaryStats: { ...createEmptyCommandSummaryStats(), otherCommands: 1 },
      summaryParts, ongoingSummaryParts, summaryText: summarizeDisplayParts(summaryParts),
      ongoingSummaryText: summarizeDisplayParts(ongoingSummaryParts) };
  }
  const definition = pathTools[tool];
  const path = typeof args.path === "string" && args.path.trim() ? args.path : null;
  const pattern = typeof args.pattern === "string" ? args.pattern : null;
  if (!definition || (!path && tool !== "glob" && tool !== "grep") || ((tool === "glob" || tool === "grep") && !pattern)) return null;
  const target: ThreadCommandDisplayPart[] = [];
  if (pattern) target.push({ type: "pattern", pattern, syntax: tool === "grep" ? "regex" : "literal" }, { type: "text", text: " in " });
  target.push({ type: "path", path: path ?? "." });
  const summaryParts: ThreadCommandDisplayPart[] = [{ type: "text", text: `${definition.done} ` }, ...target];
  const ongoingSummaryParts: ThreadCommandDisplayPart[] = [{ type: "text", text: `${definition.ongoing} ` }, ...target];
  const stats = createEmptyCommandSummaryStats();
  if (definition.stat) stats[definition.stat] = 1;
  else stats.otherCommands = 1;
  return { claimedBy: `opencode.${tool}`, omitFromDisplay: false, shell: null, showShell: false,
    summaryKind: "matched", summaryStats: stats, summaryParts, ongoingSummaryParts,
    summaryText: summarizeDisplayParts(summaryParts), ongoingSummaryText: summarizeDisplayParts(ongoingSummaryParts) };
}

export function getOpenCodeToolDisplay(item: NativeItem): ThreadCommandSummaryDisplay | null {
  if (item.namespace !== "opencode") return null;
  const args = record(item.arguments);
  if (item.tool !== "execute") return args ? summary(item.tool, args) : null;
  const calls = record(item.metadata)?.toolCalls;
  if (!Array.isArray(calls)) return null;
  const detailRows: ThreadCommandDetailRow[] = calls.flatMap((value, index) => {
    const call = record(value);
    if (!call || typeof call.tool !== "string") return [];
    const input = record(call.input);
    const display = input ? summary(call.tool, input) : null;
    const query = input && typeof input.query === "string" ? input.query : null;
    const state = call.status === "running" ? "inProgress" : call.status === "completed" ? "completed"
      : call.status === "error" ? "failed" : null;
    if (!state) return [];
    return [{ id: `${item.id}:${index}`, state, summaryParts: display
      ? state === "inProgress" ? display.ongoingSummaryParts : display.summaryParts
      : [{ type: "text", text: call.tool, variant: "code" }, ...(query ? [{ type: "text" as const, text: ` ${query}` }] : [])] }];
  });
  if (!detailRows.length) return null;
  const parts = detailRows.flatMap((row, index): ThreadCommandDisplayPart[] =>
    [...(index ? [{ type: "text" as const, text: ", " }] : []), ...row.summaryParts]);
  return { claimedBy: "opencode.execute", detailRows, omitFromDisplay: false, shell: null, showShell: false,
    summaryKind: "matched", summaryStats: { ...createEmptyCommandSummaryStats(), otherCommands: detailRows.length },
    summaryParts: parts, ongoingSummaryParts: parts, summaryText: summarizeDisplayParts(parts), ongoingSummaryText: summarizeDisplayParts(parts) };
}

export function getOpenCodeFileChanges(item: NativeItem) {
  const files = item.namespace === "opencode" ? record(item.metadata)?.files : null;
  if (!Array.isArray(files)) return [];
  const failed = item.status === "failed" || item.success === false;
  return files.flatMap((value, index) => {
    const file = record(value);
    if (!file || typeof file.file !== "string" || !file.file || typeof file.patch !== "string"
      || !["added", "deleted", "modified"].includes(String(file.status))) return [];
    const kind: FileUpdateChange["kind"] = file.status === "added" ? { type: "add" }
      : file.status === "deleted" ? { type: "delete" } : { type: "update", move_path: null };
    return [{ change: { path: file.file, diff: file.patch, kind }, sourceItemId: item.id, sourceChangeIndex: index,
      danger: failed, ...(failed ? { presentationLabel: "Failed" } : {}) }];
  });
}
