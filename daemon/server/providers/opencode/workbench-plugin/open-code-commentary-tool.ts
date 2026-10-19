/*
 * Exports:
 * - OPENCODE_COMMENTARY_HINT: hidden steer admitted after bare text is cut before the agent set its task status.
 * - OPENCODE_COMMENTARY_FINISHING_HINT: hidden steer admitted after bare text is cut once the task status is set.
 * - openCodeCommentaryResult: the commentary tool's result, which teaches the empty-reply turn end once the task status is set.
 * - registerOpenCodeCommentaryTool: add the direct commentary tool whose input Workbench renders as exact commentary.
 */
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { OPENCODE_COMMENTARY_TOOL_NAME } from "../opencode-workbench-rpc";

const DISCARDED = `Plain text output is not shown to the user and was discarded. Send user-visible text with \`${OPENCODE_COMMENTARY_TOOL_NAME}\``;
/** OpenCode ends a turn only at a step without tool calls, so an empty reply is the one exit an agent can produce. */
const EMPTY_REPLY_TURN_END = "If no work remains, end your turn with an empty reply: no text and no tool calls.";
const DELIVERED = "Message delivered to user.";

export const OPENCODE_COMMENTARY_HINT = `${DISCARDED}, then continue; set the task completed or blocked before ending your turn.`;
export const OPENCODE_COMMENTARY_FINISHING_HINT = `${DISCARDED}. ${EMPTY_REPLY_TURN_END}`;

export function openCodeCommentaryResult(taskStatusSet: boolean) {
  return taskStatusSet ? `${DELIVERED} ${EMPTY_REPLY_TURN_END}` : DELIVERED;
}

/** The transcript adapters own the visible item from the tool input; the executor only acknowledges. */
export function registerOpenCodeCommentaryTool(editor: ToolEditor, hasTaskStatus: (sessionID: string) => boolean) {
  editor.add({
    name: OPENCODE_COMMENTARY_TOOL_NAME,
    description: "Send the user a message they read exactly as written. Use it for every ack, progress update, plan, brief, and review; plain text output is discarded.",
    options: { codemode: false },
    input: {
      type: "object",
      properties: { text: { type: "string", description: "Markdown message, including any Workbench markup." } },
      required: ["text"],
      additionalProperties: false,
    },
    output: {},
    execute: async (_input, context) => ({ content: openCodeCommentaryResult(hasTaskStatus(context.sessionID)), output: {} }),
  });
}
