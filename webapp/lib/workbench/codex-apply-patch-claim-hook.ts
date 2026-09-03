/*
 * Exports:
 * - CodexApplyPatchClaimHookChange/CodexApplyPatchClaimHookRequest/CodexApplyPatchClaimHookDecision: validated patch summaries, hook request, and Codex PreToolUse result contracts. Keywords: codex, apply_patch, hook, claim.
 * - parseCodexApplyPatchClaimHook: validate Codex hook JSON and extract every absolute patch change and claim path. Keywords: patch, path, move, validation.
 * - allowCodexApplyPatch/denyCodexApplyPatch: build Codex-compatible PreToolUse decisions. Keywords: allow, deny, hook.
 */
import path from "node:path";

import type { PatchChangeKind } from "workbench-shared/codex/generated/app-server/v2/PatchChangeKind";

export interface CodexApplyPatchClaimHookChange {
  additions: number;
  deletions: number;
  kind: PatchChangeKind;
  path: string;
}

export interface CodexApplyPatchClaimHookRequest {
  changes: CodexApplyPatchClaimHookChange[];
  cwd: string;
  paths: string[];
  sessionId: string;
  toolUseId: string;
  turnId: string;
}

interface CodexApplyPatchClaimHookDenyDecision {
  systemMessage?: string;
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason?: string;
  };
}

type CodexApplyPatchClaimHookAllowDecision = Record<string, never>;

export type CodexApplyPatchClaimHookDecision = CodexApplyPatchClaimHookAllowDecision | CodexApplyPatchClaimHookDenyDecision;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Codex ${label} is required.`);
  return value.trim();
}

function patchChanges(command: string, cwd: string) {
  const changes = new Map<string, CodexApplyPatchClaimHookChange>();
  let currentPath: string | null = null;
  for (const line of command.split(/\r?\n/u)) {
    const header = /^\*\*\*\s+(Add File|Delete File|Update File):\s*(.+?)\s*$/u.exec(line);
    if (header) {
      const target = path.resolve(cwd, nonEmptyString(header[2], "apply_patch path"));
      const kind: PatchChangeKind = header[1] === "Add File"
        ? { type: "add" }
        : header[1] === "Delete File"
          ? { type: "delete" }
          : { move_path: null, type: "update" };
      const existing = changes.get(target);
      changes.set(target, {
        additions: existing?.additions ?? 0,
        deletions: existing?.deletions ?? 0,
        kind,
        path: target,
      });
      currentPath = target;
      continue;
    }
    const move = /^\*\*\*\s+Move to:\s*(.+?)\s*$/u.exec(line);
    if (move) {
      const current = currentPath ? changes.get(currentPath) : null;
      if (!current || current.kind.type !== "update") throw new Error("Codex apply_patch Move to has no Update File source.");
      changes.set(current.path, {
        ...current,
        kind: { move_path: path.resolve(cwd, nonEmptyString(move[1], "apply_patch move destination")), type: "update" },
      });
      continue;
    }
    const current = currentPath ? changes.get(currentPath) : null;
    if (!current || current.kind.type === "delete") continue;
    if (line.startsWith("+")) {
      changes.set(current.path, { ...current, additions: current.additions + 1 });
    } else if (line.startsWith("-")) {
      changes.set(current.path, { ...current, deletions: current.deletions + 1 });
    }
  }
  if (!changes.size) throw new Error("Codex apply_patch contains no supported file paths.");
  return [...changes.values()];
}

export function parseCodexApplyPatchClaimHook(raw: string): CodexApplyPatchClaimHookRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Codex apply_patch hook input is not valid JSON.");
  }
  const input = record(value);
  const toolInput = record(input?.tool_input);
  const cwd = path.resolve(nonEmptyString(input?.cwd, "hook cwd"));
  const sessionId = nonEmptyString(input?.session_id, "hook session_id");
  const toolUseId = nonEmptyString(input?.tool_use_id, "hook tool_use_id");
  const turnId = nonEmptyString(input?.turn_id, "hook turn_id");
  if (input?.tool_name !== "apply_patch") throw new Error("Codex claim hook only accepts apply_patch.");
  const command = nonEmptyString(toolInput?.command, "apply_patch command");
  const changes = patchChanges(command, cwd);
  const paths = changes.flatMap((change) => (
    change.kind.type === "update" && change.kind.move_path
      ? [change.path, change.kind.move_path]
      : [change.path]
  ));
  return { changes, cwd, paths: [...new Set(paths)], sessionId, toolUseId, turnId };
}

export function allowCodexApplyPatch(): CodexApplyPatchClaimHookAllowDecision {
  return {};
}

export function denyCodexApplyPatch(reason: string, systemMessage?: string): CodexApplyPatchClaimHookDenyDecision {
  return {
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 500),
    },
  };
}
