/*
 * Exports:
 * - ClaudeFileClaimCheck: shared claim policy bound to one Claude thread.
 * - createClaudeFileClaimHooks: deny native Claude Edit/Write calls whose path no active claim covers.
 */
import path from "node:path";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeFileClaimCheck = (paths: string[]) => Promise<{ allowed: boolean; uncoveredPaths: string[] }>;

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason.slice(0, 1000),
  },
});

export function createClaudeFileClaimHooks(options: {
  cwd: string;
  check: ClaudeFileClaimCheck;
  onDenied(toolUseId: string): void;
}): { PreToolUse: HookCallbackMatcher[] } {
  return {
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
