/*
 * Exports:
 * - default WorkbenchRipgrepController: own safe ripgrep arguments and exit semantics above shared Codex command execution.
 */
import { WorkbenchRipgrepExecutionRequestSchema } from "./lib/workbench/commands/ripgrep-command-definition";
import type { JsonRpcRequest, JsonRpcResponse } from "./bridge-types";
import CodexCommandExecController from "./CodexCommandExecController";

interface WorkbenchRipgrepControllerOptions {
  commandExec?: Pick<CodexCommandExecController, "execute">;
  createProcessId?: () => string;
  reportError?: (message: string) => void;
  requestCodex?: (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
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

export default class WorkbenchRipgrepController {
  private readonly commandExec: Pick<CodexCommandExecController, "execute">;

  constructor({ commandExec, createProcessId, reportError, requestCodex }: WorkbenchRipgrepControllerOptions) {
    if (!commandExec && !requestCodex) throw new Error("Codex command execution is not configured.");
    this.commandExec = commandExec ?? new CodexCommandExecController({ createProcessId, reportError, requestCodex: requestCodex! });
  }

  async execute(input: object, signal: AbortSignal) {
    const request = WorkbenchRipgrepExecutionRequestSchema.safeParse(input);
    if (!request.success) return new Response("A valid ripgrep request is required.\n", { status: 400 });
    if (request.data.args.some(forbiddenProcessArgument)) {
      return new Response("Ripgrep process-launching arguments are unavailable in the read-only Workbench search tool.\n", { status: 400 });
    }
    if (signal.aborted) throw signal.reason;

    try {
      const result = await this.commandExec.execute({
        command: ["rg", "--no-config", "--heading", ...request.data.args],
        cwd: request.data.cwd,
        disableTimeout: true,
        env: { RIPGREP_CONFIG_PATH: null },
        sandboxPolicy: { type: "dangerFullAccess" },
      }, signal);
      const output = combinedOutput(result.stdout, result.stderr);
      if (result.exitCode === 0 || result.exitCode === 1) return new Response(output);
      return new Response(output || `Ripgrep exited with code ${result.exitCode}.\n`, { status: 400 });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return new Response(`Ripgrep could not run: ${error instanceof Error ? error.message : String(error)}\n`, { status: 400 });
    }
  }
}
