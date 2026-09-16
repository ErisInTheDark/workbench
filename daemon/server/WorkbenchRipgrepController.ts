/*
 * Exports:
 * - default WorkbenchRipgrepController: own safe ripgrep arguments and exit semantics above provider execution.
 */
import { WorkbenchRipgrepExecutionRequestSchema } from "./lib/workbench/commands/ripgrep-command-definition";
import type { WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";

interface WorkbenchRipgrepControllerOptions {
  execute: (harness: string, ...args: Parameters<WorkbenchProviderTools["executeReadOnly"]>) => ReturnType<WorkbenchProviderTools["executeReadOnly"]>;
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
  constructor(private readonly options: WorkbenchRipgrepControllerOptions) {}

  async execute(input: object, signal: AbortSignal) {
    const request = WorkbenchRipgrepExecutionRequestSchema.safeParse(input);
    if (!request.success) return new Response("A valid ripgrep request is required.\n", { status: 400 });
    if (request.data.args.some(forbiddenProcessArgument)) {
      return new Response("Ripgrep process-launching arguments are unavailable in the read-only Workbench search tool.\n", { status: 400 });
    }
    if (signal.aborted) throw signal.reason;

    try {
      const result = await this.options.execute(request.data.harness, {
        command: ["rg", "--no-config", "--heading", ...request.data.args],
        cwd: request.data.cwd,
        env: { RIPGREP_CONFIG_PATH: null },
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
