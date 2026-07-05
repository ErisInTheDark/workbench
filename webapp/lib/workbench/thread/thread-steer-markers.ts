/*
 * Exports:
 * - WORKBENCH_AGENT_SCREENSHOT_STEER_MARKER: sentinel text prefix for agent-origin screenshot steers. Keywords: steer, screenshot, sentinel, marker.
 * - createAgentScreenshotSteerText: build hidden marker text for screenshot steer inputs. Keywords: steer, screenshot, text.
 * - isAgentScreenshotSteerText/isAgentScreenshotSteerInput/isAgentScreenshotSteerUserMessage: detect screenshot steers in stored thread items. Keywords: steer, screenshot, render.
 * - getAgentScreenshotSteerImages: extract screenshot image inputs from a marked steer user message. Keywords: steer, screenshot, image.
 */
import type { ThreadItem } from "../../codex/generated/app-server/v2/ThreadItem";
import type { UserInput } from "../../codex/generated/app-server/v2/UserInput";

export const WORKBENCH_AGENT_SCREENSHOT_STEER_MARKER = "<!-- workbench-agent-screenshot-steer -->";

export function createAgentScreenshotSteerText(label?: string | null) {
  const normalizedLabel = label?.replace(/\s+/gu, " ").trim() ?? "";
  return normalizedLabel
    ? `${WORKBENCH_AGENT_SCREENSHOT_STEER_MARKER}\n${normalizedLabel}`
    : WORKBENCH_AGENT_SCREENSHOT_STEER_MARKER;
}

export function isAgentScreenshotSteerText(value: string) {
  return value.trimStart().startsWith(WORKBENCH_AGENT_SCREENSHOT_STEER_MARKER);
}

export function isAgentScreenshotSteerInput(input: UserInput) {
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
