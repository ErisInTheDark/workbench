/*
 * Exports:
 * - OpenCodeToolsControllerOptions: bind native identity to shared admitted execution.
 * - default OpenCodeToolsController: adapt OpenCode MCP metadata to Workbench tools and Codex sandbox execution.
 */
import type { WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";
import type { WorkbenchProviderCaller, WorkbenchToolTranscript } from "workbench-shared/workbench/provider/provider-execution";
import { OpenCodeToolContextSchema, type OpenCodeToolContext } from "./opencode-workbench-rpc";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";
import WorkbenchToolAdmissionController from "../../WorkbenchToolAdmissionController";
import { prepareWorkbenchShellExecution } from "../../CodexShellController";

export interface OpenCodeToolsControllerOptions {
  resolveCaller: (nativeThreadId: string, signal: AbortSignal) => Promise<{
    harness: "opencode";
    threadId: import("workbench-shared/workbench/identity").WorkbenchThreadId;
    cwd: string;
  }>;
  execute: NonNullable<WorkbenchProviderTools["execute"]>;
  executeReadOnly: WorkbenchProviderTools["executeReadOnly"];
  transcript?: {
    start(input: Parameters<WorkbenchToolTranscript["start"]>[0], context: OpenCodeToolContext, caller: WorkbenchProviderCaller): ReturnType<WorkbenchToolTranscript["start"]>;
    finish: WorkbenchToolTranscript["finish"];
  };
}

export default class OpenCodeToolsController implements WorkbenchProviderTools {
  readonly execute: NonNullable<WorkbenchProviderTools["execute"]>;
  readonly transcript: WorkbenchToolTranscript = {
    start: async (input, signal) => {
      if (input.metadata.workbenchTool === undefined) return null;
      const context = OpenCodeToolContextSchema.parse(input.metadata.workbenchTool);
      const caller = await this.caller(input.metadata, signal);
      signal.throwIfAborted();
      if (!this.options.transcript) throw new Error("OpenCode tool transcript owner is unavailable.");
      return this.options.transcript.start(input, context, caller);
    },
    finish: async (reference, result) => {
      if (!this.options.transcript) throw new Error("OpenCode tool transcript owner is unavailable.");
      await this.options.transcript.finish(reference, result);
    },
  };

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
