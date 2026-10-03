/*
 * Exports:
 * - OpenCodeToolsControllerOptions: bind native identity to shared admitted execution.
 * - default OpenCodeToolsController: adapt OpenCode MCP metadata to Workbench tools and Codex sandbox execution; Workbench hosts the shell tool.
 */
import path from "node:path";
import type { WorkbenchProviderTools } from "workbench-shared/workbench/provider/provider-execution";
import type { WorkbenchProviderCaller, WorkbenchToolTranscript } from "workbench-shared/workbench/provider/provider-execution";
import { OpenCodeFileClaimRequestSchema, OpenCodeToolContextSchema, type OpenCodeToolContext } from "./opencode-workbench-rpc";
import { NativeThreadIdSchema } from "workbench-shared/workbench/identity";

export interface OpenCodeToolsControllerOptions {
  resolveCaller: (nativeThreadId: string, signal: AbortSignal) => Promise<{
    harness: "opencode";
    threadId: import("workbench-shared/workbench/identity").WorkbenchThreadId;
    cwd: string;
  }>;
  execute: NonNullable<WorkbenchProviderTools["execute"]>;
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

  async describe() {
    return {
      experimental: {},
      shellDescription: "Run a shell command in the managed Workbench sandbox, or request Workbench approval for one outside-sandbox command.",
      shellEscalation: true,
    };
  }

  async patchClaims(...[input, check, signal]: Parameters<WorkbenchProviderTools["patchClaims"]>): Promise<string> {
    signal.throwIfAborted();
    const request = OpenCodeFileClaimRequestSchema.parse(JSON.parse(input.raw));
    const caller = await this.caller({ sessionID: request.sessionID }, signal);
    // Native internal resources are session-relative; shared claim admission requires absolute paths.
    const result = await check({ ...caller, paths: request.resources.map(resource => path.resolve(caller.cwd, resource)) });
    signal.throwIfAborted();
    return JSON.stringify(result.allowed ? { allowed: true } : {
      allowed: false,
      reason: `Unclaimed file changes: ${result.uncoveredPaths.join(", ")}. Claim every path before editing.`.slice(0, 1000),
    });
  }
}
