/*
 * Exports:
 * - WORKBENCH_USER_MESSAGE_TOOL_NAME: unprefixed name of the tool whose `text` input is the agent's exact user-visible commentary.
 * - WORKBENCH_USER_MESSAGE_TOOL_DESCRIPTION/WORKBENCH_USER_MESSAGE_TEXT_DESCRIPTION: model-visible tool and `text` field descriptions.
 * - WORKBENCH_USER_MESSAGE_DELIVERED: the tool's acknowledgement.
 *
 * Import-free: the OpenCode companion plugin loads this file, and every edit to plugin-owned files restarts OpenCode.
 */

export const WORKBENCH_USER_MESSAGE_TOOL_NAME = "message_user";
export const WORKBENCH_USER_MESSAGE_TOOL_DESCRIPTION = "Send the user a message they read exactly as written. Use it for every ack, progress update, plan, brief, and review; no other text reaches the user.";
export const WORKBENCH_USER_MESSAGE_TEXT_DESCRIPTION = "Markdown message, including any Workbench markup.";
export const WORKBENCH_USER_MESSAGE_DELIVERED = "Message delivered to user.";
