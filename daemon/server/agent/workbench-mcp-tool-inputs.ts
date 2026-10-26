/*
 * Exports:
 * - WorkbenchMcpInputShape: the provider facts that decide which input fields its agents see.
 * - readWorkbenchMcpInputShape: derive the shape from a provider's tool description and the ingress serving it.
 * - getWorkbenchMcpShellInputSchema/getWorkbenchMcpShellOutputSchema: the shell input one shape accepts, and the output it declares.
 * - getWorkbenchMcpShellWaitInputSchema: `shell_wait` input, a long wait with its own `timeoutMs`.
 * - getWorkbenchMcpCommandInputSchema: a command's input as one shape lists and validates it, with MCP-layer `timeoutMs`/`workdir`.
 * - splitWorkbenchMcpWaitTimeout: separate the MCP-layer `timeoutMs` from the command's own input.
 * - resolveWorkbenchMcpWorkdir: separate the MCP-layer `workdir` from the command's input and resolve the cwd it names.
 * - createWorkbenchMcpWaitDeadline/isWorkbenchMcpWaitTimeout: the deadline signal of a timed wait, and its abort reason.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  getWorkbenchShellInputSchema,
  WorkbenchShellCallResultSchema,
  WorkbenchShellResultSchema,
  WorkbenchYieldedShellInputSchema,
} from "workbench-shared/workbench/commands/workbench-shell-command";
import { getWorkbenchAgentCommandToolName, type WorkbenchAgentCommandDefinition } from "../lib/workbench/commands/workbench-agent-command-definition";

export interface WorkbenchMcpInputShape {
  /** Shell calls may opt into running alongside the rest of their batch. */
  parallelShells: boolean;
  /** Steer-interruptible waits accept `timeoutMs`, for providers that cannot leave a running call. */
  waitTimeouts: boolean;
  /** Shell calls accept `yield_ms` and `shell_wait` collects them, for the same providers when the ingress backgrounds shells. */
  shellYields: boolean;
}

export function readWorkbenchMcpInputShape(
  description: { toolUseIdMeta?: string; yieldsLongWaits?: boolean },
  ingress: { batchTurns?: boolean; shellYields?: boolean },
): WorkbenchMcpInputShape {
  const waitTimeouts = description.yieldsLongWaits !== true;
  return {
    // Parallel shells need a provider that names its calls and an ingress that keeps unmarked ones in batch order.
    parallelShells: Boolean(description.toolUseIdMeta) && ingress.batchTurns === true,
    waitTimeouts,
    shellYields: waitTimeouts && ingress.shellYields === true,
  };
}

export function getWorkbenchMcpShellInputSchema(shape: WorkbenchMcpInputShape) {
  return getWorkbenchShellInputSchema({ parallel: shape.parallelShells, yields: shape.shellYields });
}

/** Yielding shells may answer still running, so their declared output allows it. */
export function getWorkbenchMcpShellOutputSchema(shape: WorkbenchMcpInputShape) {
  return shape.shellYields ? WorkbenchShellCallResultSchema : WorkbenchShellResultSchema;
}

export function getWorkbenchMcpShellWaitInputSchema() {
  return WorkbenchYieldedShellInputSchema.extend(WaitTimeoutFields);
}

const WaitTimeoutFields = {
  timeoutMs: z.number().int().positive().optional()
    .describe("Stop waiting after this many milliseconds with a non-error timed-out result; call again to keep waiting."),
};
const WaitTimeoutSchema = z.object(WaitTimeoutFields);

const WorkdirFields = {
  workdir: z.string().trim().min(1).optional()
    .describe("Run as if invoked from this directory; relative to the thread cwd. Defaults to the thread cwd."),
};
const WorkdirSchema = z.object(WorkdirFields);

function offersWaitTimeout(definition: WorkbenchAgentCommandDefinition, shape: WorkbenchMcpInputShape) {
  return shape.waitTimeouts && definition.mcpSteerInterruptible === true;
}

export function getWorkbenchMcpCommandInputSchema(definition: WorkbenchAgentCommandDefinition, shape: WorkbenchMcpInputShape): z.ZodType {
  const fields: z.ZodRawShape = {
    ...(offersWaitTimeout(definition, shape) ? WaitTimeoutFields : {}),
    ...(definition.mcpWorkdir ? WorkdirFields : {}),
  };
  if (!Object.keys(fields).length) return definition.inputSchema;
  if (!(definition.inputSchema instanceof z.ZodObject)) {
    throw new Error(`Workbench MCP fields of ${getWorkbenchAgentCommandToolName(definition)} need an object input schema.`);
  }
  return definition.inputSchema.safeExtend(fields);
}

/** Commands never see `workdir`: it stands in for the cwd a CLI caller would `cd` to, resolved from the thread's own cwd. */
export async function resolveWorkbenchMcpWorkdir(
  definition: WorkbenchAgentCommandDefinition, input: object, callerCwd: string,
): Promise<{ input: object; cwd: string }> {
  if (!definition.mcpWorkdir || !Object.hasOwn(input, "workdir")) return { input, cwd: callerCwd };
  const { workdir } = WorkdirSchema.parse(input);
  const commandInput = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "workdir"));
  if (workdir === undefined) return { input: commandInput, cwd: callerCwd };
  const cwd = path.resolve(callerCwd, workdir);
  if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error(`workdir must be an existing directory: ${cwd}`);
  return { input: commandInput, cwd };
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
