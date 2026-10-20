/*
 * Exports:
 * - ClaudeFileClaimCheck: shared claim policy bound to one Claude thread.
 * - createClaudeSessionHooks: inject compact recovery context after Claude Code's own compaction, hint after plain assistant text, and deny native edits whose path no active claim covers or a pending proposal holds.
 */
import path from "node:path";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { describePendingProposalDenial, type WorkbenchFileClaimCheckResult } from "../../lib/workbench/file-claim-check";
import type ClaudeCommentaryNudge from "./ClaudeCommentaryNudge";
import { CLAUDE_COMPACTION_RECALL_CONTEXT } from "./claude-compaction-recall";

export type ClaudeFileClaimCheck = (paths: string[]) => Promise<WorkbenchFileClaimCheckResult>;

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason.slice(0, 1000),
  },
});

export function createClaudeSessionHooks(options: {
  cwd: string;
  check: ClaudeFileClaimCheck;
  onDenied(toolUseId: string): void;
  nudge: ClaudeCommentaryNudge;
}): Record<"PreToolUse" | "SessionStart" | "PostToolBatch" | "Stop", HookCallbackMatcher[]> {
  const { nudge } = options;
  return {
    PostToolBatch: [{
      hooks: [async input => {
        if (input.hook_event_name !== "PostToolBatch") return {};
        const hint = nudge.afterToolBatch();
        return hint ? { hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: hint } } : {};
      }],
    }],
    Stop: [{
      hooks: [async input => {
        if (input.hook_event_name !== "Stop") return {};
        const hint = nudge.beforeStop(input.last_assistant_message);
        return hint ? { hookSpecificOutput: { hookEventName: "Stop", additionalContext: hint } } : {};
      }],
    }],
    SessionStart: [{
      matcher: "compact",
      hooks: [async input => {
        if (input.hook_event_name !== "SessionStart" || input.source !== "compact") return {};
        return {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: CLAUDE_COMPACTION_RECALL_CONTEXT,
          },
        };
      }],
    }],
    PreToolUse: [{
      matcher: "Edit|Write",
      hooks: [async (input, toolUseId) => {
        // Matchers are patterns; only judge the exact native file tools.
        if (input.hook_event_name !== "PreToolUse" || (input.tool_name !== "Edit" && input.tool_name !== "Write")) return {};
        const toolInput = input.tool_input;
        const filePath = toolInput !== null && typeof toolInput === "object" && "file_path" in toolInput
          && typeof toolInput.file_path === "string" && toolInput.file_path.trim() ? toolInput.file_path : null;
        if (!filePath) return deny(`${input.tool_name} requires file_path before Workbench can check claims.`);
        try {
          const result = await options.check([path.resolve(options.cwd, filePath)]);
          if (result.allowed) return {};
          // Only claim denials carry the transcript's unclaimed-change presentation.
          if (!result.uncoveredPaths.length) return deny(describePendingProposalDenial(result.pendingProposals));
          options.onDenied(toolUseId ?? input.tool_use_id);
          return deny(`Unclaimed file changes: ${result.uncoveredPaths.join(", ")}. Claim every path before editing.`);
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 500) : "unknown failure";
          console.warn("[claude] file claim check failed; edit denied.", message);
          return deny(`File claim check failed. ${message}`);
        }
      }],
    }],
  };
}
