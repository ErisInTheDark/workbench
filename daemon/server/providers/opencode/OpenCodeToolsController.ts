/*
 * Exports:
 * - OpenCodeToolsControllerOptions: bind native identity to shared admitted execution.
 * - default OpenCodeToolsController: adapt OpenCode MCP metadata to Workbench tools and Codex sandbox execution.
 */
import type { WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchToolAdmissionController from "../../WorkbenchToolAdmissionController";
import { prepareWorkbenchShellExecution } from "../../CodexShellController";
import type { WorkbenchOpenCodeClient } from "./OpenCodeServiceController";

export interface OpenCodeToolsControllerOptions {
  resolveCaller: (nativeThreadId: string, signal: AbortSignal) => Promise<{
    harness: "opencode";
    threadId: import("workbench-shared/workbench/identity").WorkbenchThreadId;
    cwd: string;
  }>;
  execute: NonNullable<WorkbenchProviderTools["execute"]>;
  executeReadOnly: WorkbenchProviderTools["executeReadOnly"];
}

export default class OpenCodeToolsController implements WorkbenchProviderTools {
  readonly execute: NonNullable<WorkbenchProviderTools["execute"]>;

  constructor(private readonly options: OpenCodeToolsControllerOptions) {
    this.execute = options.execute;
  }

  async caller(metadata: Parameters<WorkbenchProviderTools["caller"]>[0], signal: AbortSignal) {
    signal.throwIfAborted();
    const value = metadata.sessionID;
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("OpenCode did not provide trusted MCP session identity.");
    }
    const nativeThreadId = NativeThreadIdSchema.parse(value.trim());
    return await this.options.resolveCaller(nativeThreadId, signal);
  }

  async shell(input: object, metadata: Parameters<WorkbenchProviderTools["caller"]>[0], signal: AbortSignal) {
    const caller = await this.caller(metadata, signal);
    const prepared = prepareWorkbenchShellExecution(input, caller.cwd);
    const admission = new WorkbenchToolAdmissionController({
      caller,
      resolve: async resolveSignal => ({
        caller: await this.caller(metadata, resolveSignal),
        writableRoots: [caller.cwd],
        network: false,
      }),
      approve: async () => false,
      execute: this.options.execute,
    });
    const result = await admission.execute(prepared, signal);
    return { ...result, cwd: prepared.cwd, shell: prepared.shell };
  }

  executeReadOnly(...input: Parameters<WorkbenchProviderTools["executeReadOnly"]>) {
    return this.options.executeReadOnly(...input);
  }

  async describe() {
    return {
      experimental: {},
      shellDescription: "Run a shell command inside the current managed Workbench sandbox.",
    };
  }

  async patchClaims(): Promise<string> {
    throw new Error("OpenCode native patch execution is disabled for managed Workbench sessions.");
  }
}
