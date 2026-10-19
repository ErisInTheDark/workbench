/*
 * Exports:
 * - OPENCODE_COMMENTARY_HINT: hidden steer text admitted after a managed agent's bare text is cut.
 * - registerOpenCodeCommentaryTool: add the direct commentary tool whose input Workbench renders as exact commentary.
 */
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { OPENCODE_COMMENTARY_TOOL_NAME } from "../opencode-workbench-rpc";

export const OPENCODE_COMMENTARY_HINT =
  `Plain text output is not shown to the user and was discarded. Send user-visible text with \`${OPENCODE_COMMENTARY_TOOL_NAME}\`, then continue.`;

/** The transcript adapters own the visible item from the tool input; the executor only acknowledges. */
export function registerOpenCodeCommentaryTool(editor: ToolEditor) {
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
    execute: async () => ({ content: "Message delivered to user.", output: {} }),
  });
}
