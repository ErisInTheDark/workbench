/*
 * Exports:
 * - CodexCommandExecRequest/CodexCommandExecResult: bounded standalone Codex process contracts. Keywords: Codex, command, exec, process, result.
 * - CodexCommandExecControllerOptions: inject app-server request, identity, and failure-reporting boundaries. Keywords: Codex, command, options, cancellation.
 * - default CodexCommandExecController: own command/exec process identity, cancellation, and response validation. Keywords: Codex, command, exec, lifecycle.
 */
import { randomUUID } from "node:crypto";

import type { SandboxPolicy } from "workbench-shared/codex/generated/app-server/v2/SandboxPolicy";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import { logError } from "./process-helpers";

export interface CodexCommandExecRequest {
  command: string[];
  cwd: string;
  disableTimeout?: boolean;
  env?: Record<string, string | null>;
  sandboxPolicy?: SandboxPolicy;
  timeoutMs?: number;
}

export interface CodexCommandExecResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

type RequestCodex = (request: JsonRpcRequest) => Promise<JsonRpcResponse>;

export interface CodexCommandExecControllerOptions {
  createProcessId?: () => string;
  reportError?: (message: string) => void;
  requestCodex: RequestCodex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readCommandExecResult(response: JsonRpcResponse): CodexCommandExecResult {
  if (response.error) throw new Error(response.error.message);
  const result = response.result;
  if (
    !isRecord(result)
    || typeof result.exitCode !== "number"
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
  ) {
    throw new Error("Codex command/exec returned an invalid response.");
  }
  return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
}

export default class CodexCommandExecController {
  private readonly createProcessId: () => string;
  private readonly reportError: (message: string) => void;
  private readonly requestCodex: RequestCodex;

  constructor({ createProcessId = randomUUID, reportError = (message) => logError("codex-command-exec", message), requestCodex }: CodexCommandExecControllerOptions) {
    this.createProcessId = createProcessId;
    this.reportError = reportError;
    this.requestCodex = requestCodex;
  }

  async execute(request: CodexCommandExecRequest, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;

    const processId = this.createProcessId();
    let termination: Promise<void> | null = null;
    const terminate = () => {
      termination ??= this.requestCodex({
        method: "command/exec/terminate",
        params: { processId },
      }).then((response) => {
        if (response.error) throw new Error(response.error.message);
      }).catch((error) => {
        this.reportError(`failed to terminate Codex command process: ${error instanceof Error ? error.message : String(error)}`);
      });
      return termination;
    };
    const abort = () => { void terminate(); };
    signal.addEventListener("abort", abort, { once: true });

    try {
      const response = await this.requestCodex({
        method: "command/exec",
        params: { ...request, processId },
      });
      if (signal.aborted) {
        await terminate();
        throw signal.reason;
      }
      return readCommandExecResult(response);
    } catch (error) {
      if (signal.aborted) {
        await terminate();
        throw signal.reason;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
