/*
 * Exports:
 * - openCodeEndTurnResult: the end turn tool's result for each outcome, telling a refused agent what to do first.
 * - registerOpenCodeEndTurnTool: add the direct tool managed agents call to end their turn.
 */
import type { ToolEditor } from "@opencode/plugin/promise/tool";
import { OPENCODE_END_TURN_TOOL_NAME } from "../opencode-workbench-rpc";
import type { OpenCodeEndTurnOutcome } from "./OpenCodeStreamCutController";

const RESULTS: Record<OpenCodeEndTurnOutcome, string> = {
  "ending": "Turn ended.",
  "status-missing": "Turn not ended: set the task completed or blocked first.",
  "steer-pending": "Turn not ended: a new user message is waiting. Handle it first.",
  "unavailable": "Turn not ended: Workbench cannot end it this way. End with a response that has no tool calls.",
};

export function openCodeEndTurnResult(outcome: OpenCodeEndTurnOutcome) {
  return RESULTS[outcome];
}

/**
 * OpenCode ends a turn only at a step without tool calls, which tool-loop models struggle to produce. This tool lets
 * them end through a call: the stream cutter turns their next step into that empty step.
 */
export function registerOpenCodeEndTurnTool(editor: ToolEditor, endTurn: (sessionID: string) => OpenCodeEndTurnOutcome) {
  editor.add({
    name: OPENCODE_END_TURN_TOOL_NAME,
    description: "End your turn.",
    options: { codemode: false },
    input: { type: "object", properties: {}, additionalProperties: false },
    output: {},
    execute: async (_input, context) => ({ content: openCodeEndTurnResult(endTurn(context.sessionID)), output: {} }),
  });
}
