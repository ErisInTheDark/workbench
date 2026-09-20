/*
 * Exports:
 * - WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT: private one-call correlation field stripped before WB validation.
 * - default CodeModeToolContextController: correlate concurrent OpenCode tool calls with exact managed sessions.
 */
import { randomUUID } from "node:crypto";

export const WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT = "__workbenchToolContext";

interface PendingToolContext {
  callId: string;
  sessionId: string;
  tool: string;
  assistantMessageId?: string;
}

function inputRecord(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Managed Workbench tools require object input.");
  }
  return input as Record<string, unknown>;
}

export default class CodeModeToolContextController {
  private readonly pending = new Map<string, PendingToolContext>();

  issue(input: unknown, context: PendingToolContext) {
    const token = randomUUID();
    inputRecord(input)[WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT] = token;
    this.pending.set(token, context);
    return token;
  }

  consume(input: unknown) {
    const record = inputRecord(input);
    const token = record[WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT];
    if (token === undefined) return null;
    delete record[WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT];
    if (typeof token !== "string") {
      throw new Error("Workbench tool context token is invalid.");
    }
    const context = this.pending.get(token);
    if (!context) throw new Error("Workbench tool context token is unavailable or already used.");
    this.pending.delete(token);
    return { ...context, childId: token };
  }

  release(input: unknown) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const record = input as Record<string, unknown>;
    const token = record[WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT];
    delete record[WORKBENCH_CODE_MODE_CONTEXT_ARGUMENT];
    if (typeof token === "string") this.pending.delete(token);
  }

  dispose() {
    this.pending.clear();
  }
}
