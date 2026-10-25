/*
 * Exports:
 * - OPENCODE_COMMENTARY_HINT: hidden steer admitted after bare text is cut; bare text is only cut before the agent set its task status.
 * - openCodeCommentaryResult: the commentary tool's result, which points at the end turn tool once the task status is set.
 * - registerOpenCodeCommentaryTool: add the direct commentary tool whose input Workbench renders as exact commentary.
 */
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import {
  WORKBENCH_USER_MESSAGE_DELIVERED, WORKBENCH_USER_MESSAGE_TEXT_DESCRIPTION, WORKBENCH_USER_MESSAGE_TOOL_DESCRIPTION,
} from "../../../agent/workbench-user-message-tool";
import { OPENCODE_COMMENTARY_TOOL_NAME, OPENCODE_END_TURN_TOOL_NAME } from "../opencode-workbench-rpc";

const TURN_END = `If no work remains, call \`${OPENCODE_END_TURN_TOOL_NAME}\` now.`;

export const OPENCODE_COMMENTARY_HINT = `Plain text output is not shown to the user and was discarded. Send user-visible text with \`${OPENCODE_COMMENTARY_TOOL_NAME}\`, then continue; set the task completed or blocked before ending your turn.`;

export function openCodeCommentaryResult(taskStatusSet: boolean) {
  return taskStatusSet ? `${WORKBENCH_USER_MESSAGE_DELIVERED} ${TURN_END}` : WORKBENCH_USER_MESSAGE_DELIVERED;
}

/** The transcript adapters own the visible item from the tool input; the executor only acknowledges. */
export function registerOpenCodeCommentaryTool(editor: ToolEditor, hasTaskStatus: (sessionID: string) => boolean) {
  editor.add({
    name: OPENCODE_COMMENTARY_TOOL_NAME,
    description: WORKBENCH_USER_MESSAGE_TOOL_DESCRIPTION,
    options: { codemode: false },
    input: {
      type: "object",
      properties: { text: { type: "string", description: WORKBENCH_USER_MESSAGE_TEXT_DESCRIPTION } },
      required: ["text"],
      additionalProperties: false,
    },
    output: {},
    execute: async (_input, context) => ({ content: openCodeCommentaryResult(hasTaskStatus(context.sessionID)), output: {} }),
  });
}
