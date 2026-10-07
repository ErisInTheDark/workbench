/*
 * Exports:
 * - ClaudeFileClaimCheck: shared claim policy bound to one Claude thread.
 * - createClaudeSessionHooks: inject compact recovery context and deny native edits whose path no active claim covers.
 */
import path from "node:path";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeFileClaimCheck = (paths: string[]) => Promise<{ allowed: boolean; uncoveredPaths: string[] }>;

const CLAUDE_COMPACTION_RECALL_CONTEXT =
  "Before following any command suggested by the compaction summary above, perform the required narrative recall(s) with `mcp__wb__thread_recall`.";

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason.slice(0, 1000),
  },
});

export function createClaudeSessionHooks(options: {
  cwd: string;
  check: ClaudeFileClaimCheck;
  onDenied(toolUseId: string): void;
}): { PreToolUse: HookCallbackMatcher[]; SessionStart: HookCallbackMatcher[] } {
  return {
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
