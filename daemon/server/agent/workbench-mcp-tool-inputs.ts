/*
 * Exports:
 * - WorkbenchMcpInputShape: the provider facts that decide which input fields its agents see.
 * - readWorkbenchMcpInputShape: derive the shape from a provider's tool description and the ingress serving it.
 * - getWorkbenchMcpShellInputSchema: the shell input one shape accepts.
 * - getWorkbenchMcpCommandInputSchema: a command's input as one shape lists and validates it.
 * - splitWorkbenchMcpWaitTimeout: separate the MCP-layer `timeoutMs` from the command's own input.
 * - createWorkbenchMcpWaitDeadline/isWorkbenchMcpWaitTimeout: the deadline signal of a timed wait, and its abort reason.
 */
import { z } from "zod";
import { getWorkbenchShellInputSchema } from "workbench-shared/workbench/commands/workbench-shell-command";
import { getWorkbenchAgentCommandToolName, type WorkbenchAgentCommandDefinition } from "../lib/workbench/commands/workbench-agent-command-definition";

export interface WorkbenchMcpInputShape {
  /** Shell calls may ask Workbench to approve running outside the sandbox. */
  escalation: boolean;
  /** Shell calls may opt into running alongside the rest of their batch. */
  parallelShells: boolean;
  /** Steer-interruptible waits accept `timeoutMs`, for providers that cannot leave a running call. */
  waitTimeouts: boolean;
}

export function readWorkbenchMcpInputShape(
  description: { shellEscalation: boolean; toolUseIdMeta?: string; yieldsLongWaits?: boolean },
  batchTurns: boolean | undefined,
): WorkbenchMcpInputShape {
  return {
    escalation: description.shellEscalation,
    // Parallel shells need a provider that names its calls and an ingress that keeps unmarked ones in batch order.
    parallelShells: Boolean(description.toolUseIdMeta) && batchTurns === true,
    waitTimeouts: description.yieldsLongWaits !== true,
  };
}

export function getWorkbenchMcpShellInputSchema(shape: WorkbenchMcpInputShape) {
  return getWorkbenchShellInputSchema({ escalation: shape.escalation, parallel: shape.parallelShells });
}

const WaitTimeoutFields = {
  timeoutMs: z.number().int().positive().optional()
    .describe("Stop waiting after this many milliseconds with a non-error timed-out result; call again to keep waiting."),
};
const WaitTimeoutSchema = z.object(WaitTimeoutFields);

function offersWaitTimeout(definition: WorkbenchAgentCommandDefinition, shape: WorkbenchMcpInputShape) {
  return shape.waitTimeouts && definition.mcpSteerInterruptible === true;
}

export function getWorkbenchMcpCommandInputSchema(definition: WorkbenchAgentCommandDefinition, shape: WorkbenchMcpInputShape): z.ZodType {
  if (!offersWaitTimeout(definition, shape)) return definition.inputSchema;
  if (!(definition.inputSchema instanceof z.ZodObject)) {
    throw new Error(`Workbench long wait ${getWorkbenchAgentCommandToolName(definition)} needs an object input schema.`);
  }
  return definition.inputSchema.safeExtend(WaitTimeoutFields);
}

/** Commands never see `timeoutMs`: their strict schemas re-validate the rest when building the request. */
export function splitWorkbenchMcpWaitTimeout(
  definition: WorkbenchAgentCommandDefinition, shape: WorkbenchMcpInputShape, input: object,
): { input: object; timeoutMs: number | null } {
  if (!offersWaitTimeout(definition, shape) || !Object.hasOwn(input, "timeoutMs")) return { input, timeoutMs: null };
  return {
    input: Object.fromEntries(Object.entries(input).filter(([key]) => key !== "timeoutMs")),
    timeoutMs: WaitTimeoutSchema.parse(input).timeoutMs ?? null,
  };
}

/** A platform timer signal, so no closure of this module generation outlives a reload while the wait continues. */
export function createWorkbenchMcpWaitDeadline(timeoutMs: number) {
  return AbortSignal.timeout(timeoutMs);
}

export function isWorkbenchMcpWaitTimeout(reason: unknown) {
  return reason instanceof DOMException && reason.name === "TimeoutError";
}
