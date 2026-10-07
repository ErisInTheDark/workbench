/*
 * Exports:
 * - OpenCodeToolsControllerOptions: bind native identity to shared admitted execution.
 * - default OpenCodeToolsController: adapt OpenCode MCP metadata to Workbench tools and prepared Codex sandbox execution; Workbench hosts the shell tool.
 */
import path from "node:path";
import type { WorkbenchProviderCaller, WorkbenchProviderTools, WorkbenchToolTranscript } from "../../provider-execution";
import { OpenCodeFileClaimRequestSchema, OpenCodeToolContextSchema, type OpenCodeToolContext } from "./opencode-workbench-rpc";
import {
  NativeThreadIdSchema, type WorkbenchThreadId, type WorkbenchTurnId,
} from "workbench-shared/workbench/identity";
import type WorkbenchThreadContextRolloverController from "../../WorkbenchThreadContextRolloverController";
import { WORKBENCH_THREAD_COMPACT_TOOL_NAME } from "workbench-shared/workbench/thread/thread-context-rollover";

export interface OpenCodeToolsControllerOptions {
  resolveCaller: (nativeThreadId: string, signal: AbortSignal) => Promise<{
    harness: "opencode";
    threadId: import("workbench-shared/workbench/identity").WorkbenchThreadId;
    cwd: string;
  }>;
  prepareExecution: NonNullable<WorkbenchProviderTools["prepareExecution"]>;
  currentTurn?(nativeThreadId: string): { threadId: WorkbenchThreadId; turnId: WorkbenchTurnId } | null;
  contextRollover?: Pick<WorkbenchThreadContextRolloverController, "isActiveTool" | "toolFailed" | "toolStarted">;
  transcript?: {
    start(input: Parameters<WorkbenchToolTranscript["start"]>[0], context: OpenCodeToolContext, caller: WorkbenchProviderCaller): ReturnType<WorkbenchToolTranscript["start"]>;
    finish: WorkbenchToolTranscript["finish"];
  };
}

export default class OpenCodeToolsController implements WorkbenchProviderTools {
  readonly prepareExecution: NonNullable<WorkbenchProviderTools["prepareExecution"]>;
  readonly transcript: WorkbenchToolTranscript = {
    start: async (input, signal) => {
      if (input.metadata.workbenchTool === undefined) return null;
      const context = OpenCodeToolContextSchema.parse(input.metadata.workbenchTool);
      const caller = await this.caller(input.metadata, signal);
      signal.throwIfAborted();
      if (!this.options.transcript) throw new Error("OpenCode tool transcript owner is unavailable.");
      const rollover = input.tool === WORKBENCH_THREAD_COMPACT_TOOL_NAME
        ? this.rolloverIdentity(input.metadata, context, caller)
        : null;
      const owner = this.options.contextRollover;
      if (rollover && !owner) throw new Error("OpenCode context rollover is unavailable.");
      if (rollover) await owner!.toolStarted(rollover);
      try {
        return await this.options.transcript.start(input, context, caller);
      } catch (error) {
        if (rollover && owner!.isActiveTool(rollover)) {
          await owner!.toolFailed(rollover, error);
        }
        throw error;
      }
    },
    finish: async (reference, result) => {
      if (!this.options.transcript) throw new Error("OpenCode tool transcript owner is unavailable.");
      if (reference.tool === WORKBENCH_THREAD_COMPACT_TOOL_NAME && result.isError) {
        const owner = this.options.contextRollover;
        if (!owner) throw new Error("OpenCode context rollover is unavailable.");
        const rollover = {
          reference: rolloverReference(reference.sourceId),
          threadId: reference.threadId,
          turnId: reference.turnId,
        };
        if (owner.isActiveTool(rollover)) {
          await owner.toolFailed(rollover, new Error("Context rollover MCP call failed."));
        }
      }
      await this.options.transcript.finish(reference, result);
    },
  };

  constructor(private readonly options: OpenCodeToolsControllerOptions) {
    this.prepareExecution = options.prepareExecution;
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

  private rolloverIdentity(
    metadata: Parameters<WorkbenchProviderTools["caller"]>[0],
    context: OpenCodeToolContext,
    caller: WorkbenchProviderCaller,
  ) {
    const sessionID = metadata.sessionID;
    if (typeof sessionID !== "string") throw new Error("OpenCode context rollover session is missing.");
    const active = this.options.currentTurn?.(sessionID);
    if (!active || active.threadId !== caller.threadId) {
      throw new Error("OpenCode context rollover has no matching admitted turn.");
    }
    return {
      reference: rolloverReference(context.childID),
      threadId: active.threadId,
      turnId: active.turnId,
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

function rolloverReference(childID: string) {
  return `workbench-context-rollover:${childID}`;
}
