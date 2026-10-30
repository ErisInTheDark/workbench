/*
 * Exports:
 * - OpenCodeToolKind: how Workbench records one OpenCode tool part.
 * - OpenCodeToolStatus: native status of a recorded OpenCode tool part.
 * - openCodeToolKind: classify a tool part during live ingest.
 * - recordedOpenCodeToolKind: classify a recorded tool part on reread, agreeing with what live ingest stored.
 */
import type { SessionMessageAssistant } from "@opencode/client";
import { isOpenCodeWorkbenchToolName, OPENCODE_COMMENTARY_TOOL_NAME } from "./opencode-workbench-rpc";

/** `workbench`: Workbench records the call itself; `commentary`: the input is exact user-visible text; `tool`: a tool item. */
export type OpenCodeToolKind = "workbench" | "commentary" | "tool";
export type OpenCodeToolStatus = Extract<SessionMessageAssistant["content"][number], { type: "tool" }>["state"]["status"];

const LEGACY_COMMENTARY_TOOL_NAME = "mcp__user__message";

export function openCodeToolKind(name: string): OpenCodeToolKind {
  if (name === OPENCODE_COMMENTARY_TOOL_NAME) return "commentary";
  return isOpenCodeWorkbenchToolName(name) ? "workbench" : "tool";
}

/**
 * Pre-rename sessions recorded the legacy commentary tool as commentary, and it could not fail. Post-rename managed
 * sessions refuse that name, so a failed legacy call is the tool item live ingest stored.
 */
export function recordedOpenCodeToolKind(name: string, status: OpenCodeToolStatus): OpenCodeToolKind {
  return name === LEGACY_COMMENTARY_TOOL_NAME && status !== "error" ? "commentary" : openCodeToolKind(name);
}
