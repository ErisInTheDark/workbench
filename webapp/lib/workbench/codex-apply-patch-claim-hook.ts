/*
 * Exports:
 * - CodexApplyPatchClaimHookRequest/CodexApplyPatchClaimHookDecision: validated hook request and Codex PreToolUse result contracts. Keywords: codex, apply_patch, hook, claim.
 * - parseCodexApplyPatchClaimHook: validate Codex hook JSON and extract every absolute patch path. Keywords: patch, path, move, validation.
 * - allowCodexApplyPatch/denyCodexApplyPatch: build Codex-compatible PreToolUse decisions. Keywords: allow, deny, hook.
 */
import path from "node:path";

export interface CodexApplyPatchClaimHookRequest {
  cwd: string;
  paths: string[];
  sessionId: string;
}

export interface CodexApplyPatchClaimHookDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
  };
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Codex ${label} is required.`);
  return value.trim();
}

function patchPaths(command: string) {
  const paths: string[] = [];
  let currentUpdate: string | null = null;
  for (const line of command.split(/\r?\n/u)) {
    const header = /^\*\*\*\s+(Add File|Delete File|Update File):\s*(.+?)\s*$/u.exec(line);
    if (header) {
      const target = nonEmptyString(header[2], "apply_patch path");
      paths.push(target);
      currentUpdate = header[1] === "Update File" ? target : null;
      continue;
    }
    const move = /^\*\*\*\s+Move to:\s*(.+?)\s*$/u.exec(line);
    if (move) {
      if (!currentUpdate) throw new Error("Codex apply_patch Move to has no Update File source.");
      paths.push(nonEmptyString(move[1], "apply_patch move destination"));
    }
  }
  if (!paths.length) throw new Error("Codex apply_patch contains no supported file paths.");
  return [...new Set(paths)];
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
  if (input?.tool_name !== "apply_patch") throw new Error("Codex claim hook only accepts apply_patch.");
  const command = nonEmptyString(toolInput?.command, "apply_patch command");
  return { cwd, paths: patchPaths(command).map((candidate) => path.resolve(cwd, candidate)), sessionId };
}

export function allowCodexApplyPatch(): CodexApplyPatchClaimHookDecision {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

export function denyCodexApplyPatch(reason: string): CodexApplyPatchClaimHookDecision {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 500),
    },
  };
}
