/*
 * Exports:
 * - default ClaudeToolsController: resolve server-owned Claude MCP scopes and run admitted shell commands.
 */
import type { WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";
import WorkbenchToolAdmissionController from "../../WorkbenchToolAdmissionController";
import { prepareWorkbenchShellExecution } from "../../CodexShellController";
import type ClaudeThreadOperations from "./ClaudeThreadOperations";
import type ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";

export default class ClaudeToolsController implements WorkbenchProviderTools {
  readonly execute: NonNullable<WorkbenchProviderTools["execute"]>;
  readonly transcript: NonNullable<WorkbenchProviderTools["transcript"]>;

  constructor(private readonly options: {
    threads: ClaudeThreadOperations;
    transcript: ClaudeTranscriptAdapter;
    execute: NonNullable<WorkbenchProviderTools["execute"]>;
  }) {
    this.execute = options.execute;
    this.transcript = {
      start: async (input, signal, context) => {
        signal.throwIfAborted();
        const runtime = this.scope(context);
        return options.transcript.startToolTranscript({
          threadId: runtime.threadId, turnId: runtime.turnId,
          tool: input.tool, arguments: input.arguments,
        });
      },
      finish: (reference, result) => options.transcript.finishToolTranscript(reference, result),
    };
  }

  private scope(context: Parameters<WorkbenchProviderTools["caller"]>[2]) {
    if (!context) throw new Error("Claude MCP request has no server-owned client scope.");
    return this.options.threads.resolveScope(context.clientScope);
  }

  async caller(_metadata: Parameters<WorkbenchProviderTools["caller"]>[0], signal: AbortSignal,
    context?: Parameters<WorkbenchProviderTools["caller"]>[2]) {
    signal.throwIfAborted();
    const runtime = this.scope(context);
    return { harness: "claude", threadId: runtime.threadId, cwd: runtime.cwd };
  }

  async shell(input: Parameters<WorkbenchProviderTools["shell"]>[0],
    metadata: Parameters<WorkbenchProviderTools["shell"]>[1], signal: AbortSignal,
    context?: Parameters<WorkbenchProviderTools["shell"]>[3]) {
    const caller = await this.caller(metadata, signal, context);
    const prepared = prepareWorkbenchShellExecution(input, caller.cwd);
    const admission = new WorkbenchToolAdmissionController({
      caller,
      resolve: async resolveSignal => ({
        caller: await this.caller(metadata, resolveSignal, context),
        writableRoots: [caller.cwd], network: false,
      }),
      approve: (request, approveSignal) => this.options.threads.requestShellApproval(request, approveSignal),
      execute: this.execute,
    });
    const result = await admission.execute({
      ...prepared,
      ...(context?.itemId ? { itemId: context.itemId } : {}),
      ...(context?.turnId ? { turnId: context.turnId } : {}),
    }, signal);
    return { ...result, cwd: prepared.cwd, shell: prepared.shell };
  }

  async describe() {
    return {
      experimental: {},
      shellDescription: "Run a shell command in the managed Workbench sandbox, or request Workbench approval for one outside-sandbox command.",
      shellEscalation: true,
    };
  }

  async patchClaims(): Promise<string> {
    throw new Error("Claude native Edit/Write claims are checked in-process by the Claude session hook, not the shared patch hook.");
  }
}
