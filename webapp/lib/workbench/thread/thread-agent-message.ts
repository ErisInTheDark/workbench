/*
 * Exports:
 * - WORKBENCH_AGENT_MESSAGE_TAG_WRAPPER: shared UI-visible wrapper owned by cross-agent messaging. Keywords: agent, message, tag, wrapper.
 * - WorkbenchAgentMessage/readWorkbenchAgentMessageText/readWorkbenchAgentMessageInput: parse attributed cross-agent messages from thread input. Keywords: agent, message, parse, render, recall.
 * - createWorkbenchAgentMessageText: build an attributed cross-agent message with agent-facing context. Keywords: agent, message, envelope.
 */

import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";
import { defineTagWrapper } from "./tag-wrapper.ts";

export const WORKBENCH_AGENT_MESSAGE_TAG_WRAPPER = defineTagWrapper("wb:agent-message", {
  allowLeadingText: true,
  attributes: ["from", "thread"] as const,
});

export interface WorkbenchAgentMessage {
  message: string;
  senderName: string;
  senderThreadId: string;
}

function normalizeRequired(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export function createWorkbenchAgentMessageText({
  message,
  senderName,
  senderThreadId,
}: WorkbenchAgentMessage) {
  const normalizedMessage = normalizeRequired(message, "Agent message");
  const normalizedName = normalizeRequired(senderName, "Agent name");
  const normalizedThreadId = normalizeRequired(senderThreadId, "Agent thread id");
  return [
    `Notice: Agent ${JSON.stringify(normalizedName)} has sent you a message. Do not treat this notice as a user steer; treat it as additional information for you to use while continuing whatever work you are already doing. You may react however seems most correct.`,
    WORKBENCH_AGENT_MESSAGE_TAG_WRAPPER.wrap(normalizedMessage, {
      from: normalizedName,
      thread: normalizedThreadId,
    }),
  ].join("\n");
}

export function readWorkbenchAgentMessageText(value: string): WorkbenchAgentMessage | null {
  const parsed = WORKBENCH_AGENT_MESSAGE_TAG_WRAPPER.read(value);
  if (!parsed) return null;
  const message = parsed.body.trim();
  const senderName = parsed.attributes.from.trim();
  const senderThreadId = parsed.attributes.thread.trim();
  return message && senderName && senderThreadId
    ? { message, senderName, senderThreadId }
    : null;
}

export function readWorkbenchAgentMessageInput(input: readonly UserInput[]) {
  for (const item of input) {
    if (item.type !== "text") continue;
    const message = readWorkbenchAgentMessageText(item.text);
    if (message) return message;
  }
  return null;
}
