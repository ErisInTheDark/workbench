/*
 * Exports:
 * - default WorkbenchRipgrepController: own safe ripgrep execution through Codex, cancellation, and exit semantics. Keywords: ripgrep, search, Codex, process, cancellation.
 */
import { randomUUID } from "node:crypto";

import { WorkbenchRipgrepExecutionRequestSchema } from "../lib/workbench/commands/ripgrep-command-definition";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import { logError } from "./process-helpers";

interface RipgrepProcessResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

type RequestCodex = (request: JsonRpcRequest) => Promise<JsonRpcResponse>;

interface WorkbenchRipgrepControllerOptions {
  createProcessId?: () => string;
  reportError?: (message: string) => void;
  requestCodex: RequestCodex;
}

function combinedOutput(stdout: string, stderr: string) {
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`;
}

function forbiddenProcessArgument(argument: string) {
  return argument === "--pre"
    || argument.startsWith("--pre=")
    || argument === "--hostname-bin"
    || argument.startsWith("--hostname-bin=");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readRipgrepProcessResult(response: JsonRpcResponse): RipgrepProcessResult {
  if (response.error) throw new Error(response.error.message);
  const result = response.result;
  if (
    !isRecord(result)
    || typeof result.exitCode !== "number"
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
  ) {
    throw new Error("Codex command/exec returned an invalid ripgrep response.");
  }
  return {
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

export default class WorkbenchRipgrepController {
  private readonly createProcessId: () => string;
  private readonly reportError: (message: string) => void;
  private readonly requestCodex: RequestCodex;

  constructor({ createProcessId = randomUUID, reportError = (message) => logError("ripgrep", message), requestCodex }: WorkbenchRipgrepControllerOptions) {
    this.createProcessId = createProcessId;
    this.reportError = reportError;
    this.requestCodex = requestCodex;
  }

  async execute(input: object, signal: AbortSignal) {
    const request = WorkbenchRipgrepExecutionRequestSchema.safeParse(input);
    if (!request.success) return new Response("A valid ripgrep request is required.\n", { status: 400 });
    if (request.data.args.some(forbiddenProcessArgument)) {
      return new Response("Ripgrep process-launching arguments are unavailable in the read-only Workbench search tool.\n", { status: 400 });
    }
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
        this.reportError(`failed to terminate Codex ripgrep process: ${error instanceof Error ? error.message : String(error)}`);
      });
      return termination;
    };
    const abort = () => { void terminate(); };
    signal.addEventListener("abort", abort, { once: true });

    try {
      const response = await this.requestCodex({
        method: "command/exec",
        params: {
          command: ["rg", "--no-config", "--heading", ...request.data.args],
          cwd: request.data.cwd,
          disableTimeout: true,
          env: { RIPGREP_CONFIG_PATH: null },
          processId,
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      });
      if (signal.aborted) {
        await terminate();
        throw signal.reason;
      }

      const result = readRipgrepProcessResult(response);
      const output = combinedOutput(result.stdout, result.stderr);
      if (result.exitCode === 0 || result.exitCode === 1) return new Response(output);
      return new Response(output || `Ripgrep exited with code ${result.exitCode}.\n`, { status: 400 });
    } catch (error) {
      if (signal.aborted) {
        await terminate();
        throw signal.reason;
      }
      return new Response(`Ripgrep could not run: ${error instanceof Error ? error.message : String(error)}\n`, { status: 400 });
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
