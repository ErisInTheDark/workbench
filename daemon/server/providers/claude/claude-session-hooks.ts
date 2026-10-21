/*
 * Exports:
 * - ClaudeFileClaimCheck: shared claim policy bound to one Claude thread.
 * - ClaudeToolBatchPort: the thread's provider tool batch, reached through the attached bridge.
 * - claudeToolUseIds/claudeToolResults: the ordered call ids one Claude message issues, and the call outcomes one reports.
 * - createClaudeSessionHooks: inject compact recovery context after Claude Code's own compaction, hint after plain assistant text,
 *   refuse a questionnaire whose introducing text went unseen,
 *   skip native edits after an earlier failed call in their batch, deny native edits whose path no active claim covers or a pending
 *   proposal holds, and end finished batches.
 */
import path from "node:path";
import type { HookCallbackMatcher, HookJSONOutput, SDKAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WorkbenchAgentBatchTurn } from "../../agent/workbench-agent-mcp-request-registry";
import { describePendingProposalDenial, type WorkbenchFileClaimCheckResult } from "../../lib/workbench/file-claim-check";
import type ClaudeCommentaryNudge from "./ClaudeCommentaryNudge";
import { CLAUDE_COMPACTION_RECALL_CONTEXT } from "./claude-compaction-recall";

export type ClaudeFileClaimCheck = (paths: string[]) => Promise<WorkbenchFileClaimCheckResult>;

export interface ClaudeToolBatchPort {
  /** Waits for every earlier call of the batch to report its result. */
  turn(toolUseId: string, toolName: string, signal: AbortSignal): Promise<WorkbenchAgentBatchTurn>;
  end(): void;
}

const CLAUDE_QUESTIONNAIRE_TOOL_NAME = "mcp__wb__request_user_input";
const SKIPPED_AFTER_FAILURE = "Skipped: an earlier call in this batch failed. Read its result, then call this again if it still applies.";
const INTERRUPTED_BEFORE_START = "Interrupted before it started: a new message arrived for this thread. Read it, then call this again if it still applies.";

export function claudeToolUseIds(content: SDKAssistantMessage["message"]["content"]) {
  return content.flatMap(block => block.type === "tool_use" ? [block.id] : []);
}

/** Every call ends in a result block, including calls Claude rejects before any hook runs. */
export function claudeToolResults(content: SDKUserMessage["message"]["content"]) {
  return typeof content === "string" ? [] : content.flatMap(block => (
    block.type === "tool_result" ? [{ key: block.tool_use_id, failed: block.is_error === true }] : []
  ));
}

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
  batch: ClaudeToolBatchPort;
}): Record<"PreToolUse" | "SessionStart" | "PostToolBatch" | "Stop", HookCallbackMatcher[]> {
  const { batch, nudge } = options;
  return {
    PostToolBatch: [{
      hooks: [async input => {
        if (input.hook_event_name !== "PostToolBatch") return {};
        batch.end();
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
      matcher: CLAUDE_QUESTIONNAIRE_TOOL_NAME,
      hooks: [async input => {
        if (input.hook_event_name !== "PreToolUse" || input.tool_name !== CLAUDE_QUESTIONNAIRE_TOOL_NAME) return {};
        const hint = nudge.beforeQuestionnaire();
        return hint ? deny(hint) : {};
      }],
    }, {
      matcher: "Edit|Write",
      hooks: [async (input, toolUseId, { signal }) => {
        // Matchers are patterns; only judge the exact native file tools.
        if (input.hook_event_name !== "PreToolUse" || (input.tool_name !== "Edit" && input.tool_name !== "Write")) return {};
        const toolInput = input.tool_input;
        const filePath = toolInput !== null && typeof toolInput === "object" && "file_path" in toolInput
          && typeof toolInput.file_path === "string" && toolInput.file_path.trim() ? toolInput.file_path : null;
        if (!filePath) return deny(`${input.tool_name} requires file_path before Workbench can check claims.`);
        try {
          const turn = await batch.turn(toolUseId ?? input.tool_use_id, input.tool_name, signal);
          if (turn !== "ready") return deny(turn === "skipped" ? SKIPPED_AFTER_FAILURE : INTERRUPTED_BEFORE_START);
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
