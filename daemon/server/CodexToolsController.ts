/*
 * Exports:
 * - default CodexToolsController: interpret Codex MCP metadata, gate apply_patch on claims and sandbox ACL repair, prepare tools for its native sandbox, and expose the executor's command roots for reaping.
 */
import { NativeThreadIdSchema, type NativeThreadId, type WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { ProviderToolMetadata, WorkbenchProviderTools } from "./provider-execution";
import CodexShellController, { WORKBENCH_SHELL_SANDBOX_CAPABILITY, WORKBENCH_SHELL_TOOL_DESCRIPTION } from "./CodexShellController";
import type CodexSandboxAclController from "./CodexSandboxAclController";
import type CodexExecServer from "./CodexExecServer";
import { allowCodexApplyPatch, denyCodexApplyPatch, parseCodexApplyPatchClaimHook } from "./lib/workbench/codex-apply-patch-claim-hook";
import { describePendingProposalDenial } from "./lib/workbench/file-claim-check";
import {
  createWorkbenchFileChangeFailureSystemMessage, WORKBENCH_UNCLAIMED_FILE_CHANGE_REASON_PREFIX,
} from "workbench-shared/workbench/thread/workbench-file-change";

export default class CodexToolsController implements WorkbenchProviderTools {
  readonly prepareExecution: WorkbenchProviderTools["prepareExecution"];
  /** The executor's command roots and a sandboxed runner, for reaping commands an earlier executor left running. */
  readonly processes: {
    executor: Pick<CodexExecServer, "generation" | "onRoot">;
    runSandboxed: CodexShellController["runSandboxed"];
  } | null;

  constructor(private readonly options: {
    readCallerThread(nativeThreadId: NativeThreadId): Promise<{ id: WorkbenchThreadId; cwd: string }>;
    resolvePatchCaller(threadId: string, cwd: string): Promise<{ threadId: WorkbenchThreadId; nativeThreadId: NativeThreadId }>;
    /** Repairs Windows sandbox write ACEs on patch targets so the sandboxed apply_patch can write them. */
    sandboxAcl?: Pick<CodexSandboxAclController, "ensureWritable">;
    shell: Pick<CodexShellController, "prepare"> & Partial<Pick<CodexShellController, "prepareAdmitted" | "runSandboxed">>;
    executor?: Pick<CodexExecServer, "generation" | "onRoot">;
  }) {
    this.prepareExecution = options.shell.prepareAdmitted?.bind(options.shell);
    const runSandboxed = options.shell.runSandboxed;
    this.processes = options.executor && runSandboxed ? { executor: options.executor, runSandboxed } : null;
  }

  async patchClaims(...[input, check, signal]: Parameters<WorkbenchProviderTools["patchClaims"]>) {
    try {
      signal.throwIfAborted();
      const hook = parseCodexApplyPatchClaimHook(input.raw);
      const caller = await this.options.resolvePatchCaller(input.callerThreadId ?? hook.sessionId, hook.cwd);
      signal.throwIfAborted();
      if (hook.sessionId !== caller.nativeThreadId) throw new Error("Codex hook session_id does not match the managed thread.");
      const [result] = await Promise.all([
        check({ cwd: hook.cwd, harness: "codex", paths: hook.paths, threadId: caller.threadId }),
        this.options.sandboxAcl?.ensureWritable(hook.paths, signal, this.options.shell.runSandboxed),
      ]);
      signal.throwIfAborted();
      if (result.allowed) return JSON.stringify(allowCodexApplyPatch());
      if (!result.uncoveredPaths.length) return JSON.stringify(denyCodexApplyPatch(describePendingProposalDenial(result.pendingProposals)));
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

  async describe() {
    return {
      experimental: { [WORKBENCH_SHELL_SANDBOX_CAPABILITY]: {} },
      shellDescription: WORKBENCH_SHELL_TOOL_DESCRIPTION,
      // Codex escalates through its own native approval request, never through this tool.
      shellEscalation: false,
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

  async prepareShell(...[input, metadata, signal]: Parameters<NonNullable<WorkbenchProviderTools["prepareShell"]>>) {
    const caller = await this.caller(metadata, signal);
    return this.options.shell.prepare(input, metadata, signal, {
      nativeThreadId: this.nativeThreadId(metadata),
      workbenchThreadId: caller.threadId,
    });
  }
}
