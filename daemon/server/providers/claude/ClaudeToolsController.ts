/*
 * Exports:
 * - default ClaudeToolsController: resolve server-owned Claude MCP scopes, say where requests name their tool_use (which
 *   also places each call's transcript item), and prepare admitted commands; Workbench hosts the shell tool and may run
 *   marked shells in parallel.
 */
import type { WorkbenchProviderTools } from "../provider-execution";
import type ClaudeThreadOperations from "./ClaudeThreadOperations";
import type ClaudeTranscriptAdapter from "./ClaudeTranscriptAdapter";

/** The request `_meta` key under which Claude names each MCP call's tool_use. */
const CLAUDE_TOOL_USE_ID_META = "claudecode/toolUseId";

export default class ClaudeToolsController implements WorkbenchProviderTools {
  readonly prepareExecution: NonNullable<WorkbenchProviderTools["prepareExecution"]>;
  readonly transcript: NonNullable<WorkbenchProviderTools["transcript"]>;

  constructor(private readonly options: {
    threads: Pick<ClaudeThreadOperations, "resolveScope">;
    transcript: ClaudeTranscriptAdapter;
    prepareExecution: NonNullable<WorkbenchProviderTools["prepareExecution"]>;
  }) {
    this.prepareExecution = options.prepareExecution;
    this.transcript = {
      start: async (input, signal, context) => {
        signal.throwIfAborted();
        const runtime = this.scope(context);
        const toolUseId = input.metadata[CLAUDE_TOOL_USE_ID_META];
        return options.transcript.startToolTranscript({
          threadId: runtime.threadId, turnId: runtime.turnId,
          tool: input.tool, arguments: input.arguments,
          // The call takes the place its tool_use block holds, so it stays where the model wrote it.
          toolUseId: typeof toolUseId === "string" && toolUseId ? toolUseId : null,
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

  async describe() {
    return {
      experimental: {},
      shellDescription: "Run a shell command in the managed Workbench sandbox, or request Workbench approval for one outside-sandbox command.",
      shellEscalation: true,
      // Claude names each MCP request's tool_use; the session host declares the same ids as its batches.
      toolUseIdMeta: CLAUDE_TOOL_USE_ID_META,
    };
  }

  async patchClaims(): Promise<string> {
    throw new Error("Claude native Edit/Write claims are checked in-process by the Claude session hook, not the shared patch hook.");
  }
}
