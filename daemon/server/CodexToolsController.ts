/*
 * Exports:
 * - default CodexToolsController: interpret Codex MCP metadata and execute tools inside its native sandbox.
 */
import { NativeThreadIdSchema, type NativeThreadId, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { ProviderToolMetadata, WorkbenchProviderTools, WorkbenchReadOnlyExecution } from "workbench-shared/workbench/provider/provider-execution";
import CodexShellController, { WORKBENCH_SHELL_SANDBOX_CAPABILITY, WORKBENCH_SHELL_TOOL_DESCRIPTION } from "./CodexShellController";
import type CodexCommandExecController from "./CodexCommandExecController";
import { allowCodexApplyPatch, denyCodexApplyPatch, parseCodexApplyPatchClaimHook } from "./lib/workbench/codex-apply-patch-claim-hook";
import {
  createWorkbenchFileChangeFailureSystemMessage, WORKBENCH_UNCLAIMED_FILE_CHANGE_REASON_PREFIX,
} from "workbench-shared/workbench/thread/workbench-file-change";

export default class CodexToolsController implements WorkbenchProviderTools {
  readonly execute: WorkbenchProviderTools["execute"];

  constructor(private readonly options: {
    readCallerThread(nativeThreadId: NativeThreadId): Promise<{ id: WorkbenchThreadId; cwd: string }>;
    resolvePatchCaller(threadId: string, cwd: string): Promise<{ threadId: WorkbenchThreadId; nativeThreadId: NativeThreadId }>;
    shell: Pick<CodexShellController, "execute"> & Partial<Pick<CodexShellController, "executeAdmitted">>;
    commandExec: Pick<CodexCommandExecController, "execute">;
  }) {
    this.execute = options.shell.executeAdmitted?.bind(options.shell);
  }

  async patchClaims(...[input, check, signal]: Parameters<WorkbenchProviderTools["patchClaims"]>) {
    try {
      signal.throwIfAborted();
      const hook = parseCodexApplyPatchClaimHook(input.raw);
      const caller = await this.options.resolvePatchCaller(input.callerThreadId ?? hook.sessionId, hook.cwd);
      signal.throwIfAborted();
      if (hook.sessionId !== caller.nativeThreadId) throw new Error("Codex hook session_id does not match the managed thread.");
      const result = await check({ cwd: hook.cwd, harness: "codex", paths: hook.paths, threadId: caller.threadId });
      signal.throwIfAborted();
      if (result.allowed) return JSON.stringify(allowCodexApplyPatch());
      const uncoveredPaths = new Set(result.uncoveredPaths);
      const uncoveredChanges = hook.changes.filter(change => uncoveredPaths.has(change.path)
        || (change.kind.type === "update" && !!change.kind.move_path && uncoveredPaths.has(change.kind.move_path)));
      return JSON.stringify(denyCodexApplyPatch(
        `${WORKBENCH_UNCLAIMED_FILE_CHANGE_REASON_PREFIX}${result.uncoveredPaths.join(", ")}. Claim every path before editing.`,
        createWorkbenchFileChangeFailureSystemMessage(uncoveredChanges) ?? undefined,
      ));
    } catch (error) {
      signal.throwIfAborted();
      return JSON.stringify(denyCodexApplyPatch(`apply_patch claim check failed. ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  executeReadOnly(request: WorkbenchReadOnlyExecution, signal: AbortSignal) {
    return this.options.commandExec.execute({
      ...request, disableTimeout: true, sandboxPolicy: { type: "dangerFullAccess" },
    }, signal);
  }

  async describe() {
    return {
      experimental: { [WORKBENCH_SHELL_SANDBOX_CAPABILITY]: {} },
      shellDescription: WORKBENCH_SHELL_TOOL_DESCRIPTION,
    };
  }

  private nativeThreadId(metadata: ProviderToolMetadata) {
    const value = metadata.threadId;
    if (typeof value !== "string" || !value.trim()) throw new Error("Codex did not provide trusted MCP thread identity.");
    return NativeThreadIdSchema.parse(value.trim());
  }

  async caller(metadata: ProviderToolMetadata, signal: AbortSignal) {
    signal.throwIfAborted();
    const thread = await this.options.readCallerThread(this.nativeThreadId(metadata));
    signal.throwIfAborted();
    if (!thread.cwd.trim()) throw new Error("Codex thread/read returned no working directory.");
    return { harness: "codex", threadId: thread.id, cwd: thread.cwd };
  }

  async shell(...[input, metadata, signal]: Parameters<WorkbenchProviderTools["shell"]>) {
    const caller = await this.caller(metadata, signal);
    return this.options.shell.execute(input, metadata, signal, {
      nativeThreadId: this.nativeThreadId(metadata),
      workbenchThreadId: caller.threadId,
    });
  }
}
