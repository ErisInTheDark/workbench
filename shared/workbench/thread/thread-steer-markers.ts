/*
 * Exports:
 * - WORKBENCH_AGENT_SCREENSHOT_STEER_MARKER: sentinel text prefix for agent-origin screenshot steers. Keywords: steer, screenshot, sentinel, marker.
 * - createAgentScreenshotSteerText: build hidden marker text for screenshot steer inputs, optionally marking the screenshot as transcript-hidden.
 * - isHiddenAgentScreenshotSteerText/isHiddenAgentScreenshotContent: whether marked screenshot text or content stays out of the transcript.
 * - isAgentScreenshotSteerText/isAgentScreenshotSteerInput/isAgentScreenshotSteerUserMessage: detect screenshot steers in stored thread items. Keywords: steer, screenshot, render.
 * - getAgentScreenshotSteerImages: extract screenshot image inputs from a marked steer user message. Keywords: steer, screenshot, image.
 */
import type { ThreadItem, UserInput } from "./workbench-thread-items.ts";

export const WORKBENCH_AGENT_SCREENSHOT_STEER_MARKER = "<!-- workbench-agent-screenshot-steer -->";
const WORKBENCH_AGENT_SCREENSHOT_STEER_PATTERN = /^<!--\s*workbench-agent-screenshot-steer(?:\s+\{[\s\S]*?\})?\s*-->/u;

/** Hidden screenshots reach the model but render nothing in the transcript, such as vis self-checks. */
export function createAgentScreenshotSteerText(options: { hidden?: boolean } = {}) {
  return options.hidden ? "<!-- workbench-agent-screenshot-steer {\"hidden\":true} -->" : WORKBENCH_AGENT_SCREENSHOT_STEER_MARKER;
}

export function isAgentScreenshotSteerText(value: string) {
  return WORKBENCH_AGENT_SCREENSHOT_STEER_PATTERN.test(value.trimStart());
}

export function isHiddenAgentScreenshotSteerText(value: string) {
  const payload = /^<!--\s*workbench-agent-screenshot-steer\s+(\{[\s\S]*?\})\s*-->/u.exec(value.trimStart())?.[1];
  if (!payload) return false;
  try {
    return (JSON.parse(payload) as { hidden?: unknown }).hidden === true;
  } catch {
    return false;
  }
}

/** Whether marked screenshot content (steer message or tool output parts) asks to stay out of the transcript. */
export function isHiddenAgentScreenshotContent(parts: readonly { type: string; text?: string }[]) {
  return parts.some((part) => typeof part.text === "string" && (part.type === "text" || part.type === "input_text") && isHiddenAgentScreenshotSteerText(part.text));
}

export function isAgentScreenshotSteerInput(input: UserInput): input is Extract<UserInput, { type: "text" }> {
  return input.type === "text" && isAgentScreenshotSteerText(input.text);
}

export function isAgentScreenshotSteerUserMessage(item: ThreadItem) {
  return item.type === "userMessage"
    && item.content.some(isAgentScreenshotSteerInput);
}

export function getAgentScreenshotSteerImages(item: Extract<ThreadItem, { type: "userMessage" }>) {
  if (!isAgentScreenshotSteerUserMessage(item)) {
    return [];
  }

  return item.content.filter((input): input is Extract<UserInput, { type: "image" }> => input.type === "image");
}
