/*
 * Exports:
 * - OPENCODE_COMMENTARY_HINT: hidden steer admitted after bare text is cut; bare text is only cut before the agent set its task status.
 * - openCodeCommentaryResult: the commentary tool's result, which teaches the empty-response turn end once the task status is set.
 * - registerOpenCodeCommentaryTool: add the direct commentary tool whose input Workbench renders as exact commentary.
 */
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { OPENCODE_COMMENTARY_TOOL_NAME } from "../opencode-workbench-rpc";

const DELIVERED = "Message delivered to user.";
/** OpenCode ends a turn only at a step without tool calls; agents read "reply" as this tool, so the exit rules it out. */
const TURN_END = "If no work remains, end your turn now with an empty response, not another message.";

export const OPENCODE_COMMENTARY_HINT = `Plain text output is not shown to the user and was discarded. Send user-visible text with \`${OPENCODE_COMMENTARY_TOOL_NAME}\`, then continue; set the task completed or blocked before ending your turn.`;

export function openCodeCommentaryResult(taskStatusSet: boolean) {
  return taskStatusSet ? `${DELIVERED} ${TURN_END}` : DELIVERED;
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
