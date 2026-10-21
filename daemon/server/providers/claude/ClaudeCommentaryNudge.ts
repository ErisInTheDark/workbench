/*
 * Exports:
 * - CLAUDE_COMMENTARY_HINT: hidden context telling Claude its plain text is not shown and where user-visible text goes.
 * - CLAUDE_QUESTIONNAIRE_CONTEXT_HINT: why a questionnaire was refused while the text introducing it went unseen.
 * - default ClaudeCommentaryNudge: per-launch state deciding when Claude's plain assistant text earns a hint or refuses a questionnaire.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isVisibleWorkbenchAgentMessageText, WORKBENCH_TURN_END_MARKER } from "workbench-shared/workbench/thread/thread-recovery-message";
import { CLAUDE_COMMENTARY_TOOL_NAME } from "./claude-commentary-tool";

export const CLAUDE_COMMENTARY_HINT = "Workbench does not show plain assistant text to the user. Resend anything the user needs to read "
  + `with \`${CLAUDE_COMMENTARY_TOOL_NAME}\`; outside that tool, write only the final \`${WORKBENCH_TURN_END_MARKER}\`.`;
export const CLAUDE_QUESTIONNAIRE_CONTEXT_HINT = "Questionnaire not shown: the plain text before it never reached the user, so they would "
  + `answer without its context. Send that text with \`${CLAUDE_COMMENTARY_TOOL_NAME}\`, then ask again.`;

export default class ClaudeCommentaryNudge {
  private strayText = false;
  private hintedLastStop = false;

  /** Must see every output message as it arrives, ahead of the hooks that follow it. */
  observe(message: SDKMessage) {
    if (message.type !== "assistant" || message.parent_tool_use_id) return;
    if (message.message.content.some(block => block.type === "text" && isVisibleWorkbenchAgentMessageText(block.text))) {
      this.strayText = true;
    }
  }

  /** A questionnaire blocks inside its batch, so unseen text before it is caught here, before the user answers blind. */
  beforeQuestionnaire(): string | null {
    if (!this.strayText) return null;
    this.strayText = false;
    return CLAUDE_QUESTIONNAIRE_CONTEXT_HINT;
  }

  afterToolBatch(): string | null {
    if (!this.strayText) return null;
    this.strayText = false;
    return CLAUDE_COMMENTARY_HINT;
  }

  /** A hinted stop continues the turn; never hinting two stops in a row lets a model that ignores the hint still end. */
  beforeStop(lastAssistantText: string | undefined): string | null {
    this.strayText = false;
    const hint = !this.hintedLastStop && lastAssistantText !== undefined && isVisibleWorkbenchAgentMessageText(lastAssistantText);
    this.hintedLastStop = hint;
    return hint ? CLAUDE_COMMENTARY_HINT : null;
  }
}
